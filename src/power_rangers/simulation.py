"""Local body coordinator and physics worker; no network/model dependencies."""

from dataclasses import asdict
import math

import mujoco
import numpy as np

from .model import COLORS, LEGS, LegKinematics, load_model
from .motions import CONTROL_DT, DECISION_TICKS, Motion
from .crawl import CrawlController, polygon, support_margin


class Simulation:
    def __init__(self, backend: str = "native", rig: bool = True):
        if backend not in ("native", "mjx"):
            raise ValueError("Unknown backend")
        self.backend = backend
        self.rig = rig
        self.model = load_model()
        self.data = mujoco.MjData(self.model)
        self.ik = LegKinematics(self.model)
        self.floor = self.model.geom("floor").id
        self.foot_geoms = {leg: self.model.geom(leg).id for leg in LEGS}
        self.trunk = self.model.body("trunk").id
        self.nsubsteps = round(CONTROL_DT / self.model.opt.timestep)
        self._mjx_model = None
        self.reset()

    def reset(self) -> None:
        mujoco.mj_resetDataKeyframe(self.model, self.data, self.model.key("home").id)
        # Settle under the stock position servos before starting the episode clock.
        for _ in range(250):
            mujoco.mj_step(self.model, self.data)
        self.data.time = 0
        mujoco.mj_forward(self.model, self.data)
        if self.rig:
            self.data.mocap_pos[0] = self.data.qpos[:3]
            self.data.mocap_quat[0] = self.data.qpos[3:7]
            self.data.eq_active[self.model.equality("calibration_rig").id] = 1
            for _ in range(250):
                mujoco.mj_step(self.model, self.data)
            self.data.time = 0
            mujoco.mj_forward(self.model, self.data)
        self.tick = 0
        self.sequence = 0
        self.active: dict[str, Motion] = {}
        self.history: list[Motion] = []
        self.targets = self.data.ctrl.copy()
        self.fallen = False
        self.crawl: CrawlController | None = None
        self.anchors = {leg: self.foot(leg).copy() for leg in LEGS}
        if self.backend == "mjx":
            self._initialize_mjx()

    def _initialize_mjx(self) -> None:
        import jax
        from mujoco import mjx
        if self._mjx_model is None:
            self._mjx_model = mjx.put_model(self.model, impl="jax")
            @jax.jit
            def advance(data, ctrl):
                data = data.replace(ctrl=ctrl)
                return jax.lax.fori_loop(0, self.nsubsteps, lambda _, d: mjx.step(self._mjx_model, d), data)
            self._mjx_step = advance
        self._mjx_data = mjx.put_data(self.model, self.data, impl="jax")

    def foot(self, leg: str) -> np.ndarray:
        return self.data.site_xpos[self.ik.sites[leg]]

    def contacts(self) -> dict[str, bool]:
        pairs = {frozenset((int(c.geom1), int(c.geom2))) for c in self.data.contact[:self.data.ncon] if c.dist <= 0.001}
        return {leg: frozenset((geom, self.floor)) in pairs for leg, geom in self.foot_geoms.items()}

    def start(self, leg: str, primitive: str = "swing_to", duration: float = 0.6, forward: float = 0.04, clearance: float = 0.04) -> Motion:
        if self.crawl is not None:
            raise ValueError("Reset to return to manual leg control")
        return self._start_motion(leg, primitive, duration, forward, clearance)

    def start_crawl(self, cycles: int = 3, external_policy: bool = False) -> None:
        if self.rig or self.data.eq_active[self.model.equality("calibration_rig").id]:
            raise ValueError("Disable the calibration rig before starting a crawl")
        if self.active or self.crawl is not None or self.fallen:
            raise ValueError("Start the crawl from a fresh standing episode")
        if not all(self.contacts().values()):
            raise ValueError("All four feet must be planted to start a crawl")
        self.crawl = CrawlController(self, cycles, external_policy=external_policy)

    def _start_motion(self, leg: str, primitive: str = "swing_to", duration: float = 0.6, forward: float = 0.04, clearance: float = 0.04) -> Motion:
        if leg not in LEGS or primitive not in ("swing_to", "support", "push"):
            raise ValueError("Unknown leg or primitive")
        if self.fallen:
            raise ValueError("Body has fallen; reset the episode")
        if leg in self.active:
            raise ValueError(f"{leg} already has an active motion")
        if not all(math.isfinite(x) for x in (duration, forward, clearance)):
            raise ValueError("Motion parameters must be finite")
        if not (0.2 <= duration <= 2 and -0.08 <= forward <= 0.08 and 0.015 <= clearance <= 0.08):
            raise ValueError("Use duration 0.2–2 s, displacement ±0.08 m, clearance 0.015–0.08 m")
        if not self.contacts()[leg]:
            raise ValueError(f"{leg} must be planted before starting this motion")
        origin = self.foot(leg).copy()
        target = origin.copy()
        heading = self.data.xmat[self.trunk].reshape(3, 3)[:, 0].copy()
        heading[2] = 0
        heading /= max(1e-9, np.linalg.norm(heading))
        if primitive != "support":
            target += heading * (forward if primitive == "swing_to" else -abs(forward))
        ticks = max(1, math.ceil(duration / CONTROL_DT - 1e-9))
        self.sequence += 1
        motion = Motion(f"{leg}-{self.sequence}", leg, primitive, self.tick, ticks, self.tick + ticks + 25, origin.tolist(), target.tolist(), clearance)
        motion.phase = "lift" if primitive == "swing_to" else primitive
        self.active[leg] = motion
        return motion

    def step(self, ticks: int = 1) -> None:
        for _ in range(ticks):
            if self.fallen:
                return
            if self.crawl is not None:
                if self.crawl.state.status == "failed":
                    return
                self.crawl.prepare(self)
                if self.crawl.state.status == "failed":
                    return
                if self.crawl.state.phase == "awaiting_decision":
                    return
                self.crawl.apply(self)
            else:
                for leg, motion in self.active.items():
                    desired = motion.desired_foot(self.tick + 1)
                    ids = self.ik.actuators[leg]
                    angles, _ = self.ik.solve(self.data, leg, desired, self.targets[ids])
                    # Cap target slew to avoid discontinuous actuator demands.
                    self.targets[ids] += np.clip(angles - self.targets[ids], -0.12, 0.12)
            self.data.ctrl[:] = self.targets
            if self.backend == "native":
                for _ in range(self.nsubsteps):
                    mujoco.mj_step(self.model, self.data)
                mujoco.mj_forward(self.model, self.data)
            else:
                import jax.numpy as jp
                from mujoco import mjx
                self._mjx_data = self._mjx_step(self._mjx_data, jp.asarray(self.targets))
                mjx.get_data_into(self.data, self.model, self._mjx_data)
                mujoco.mj_forward(self.model, self.data)
            self.tick += 1
            contact = self.contacts()
            for leg, motion in list(self.active.items()):
                if motion.observe(self.tick, contact[leg], float(self.foot(leg)[2])):
                    self.history.append(motion)
                    del self.active[leg]
                    self.anchors[leg] = self.foot(leg).copy()
            self.history = self.history[-100:]
            up = self.data.xmat[self.trunk].reshape(3, 3)[2, 2]
            self.fallen = bool(self.data.qpos[2] < 0.13 or up < 0.5 or not np.isfinite(self.data.qpos).all())
            if self.fallen:
                for motion in self.active.values():
                    motion.finish(self.tick, "failed", "body fell")
                    self.history.append(motion)
                self.active.clear()
            if self.crawl is not None:
                self.crawl.observe(self)

    def state(self) -> dict:
        contacts = self.contacts()
        support = np.array([self.foot(leg)[:2] for leg in LEGS if contacts[leg]])
        com = self.data.subtree_com[self.trunk]
        rotation = self.data.xmat[self.trunk].reshape(3, 3)
        legs = {}
        for leg in LEGS:
            active = self.active.get(leg)
            previous = next((m for m in reversed(self.history) if m.leg == leg), None)
            legs[leg] = {
                "color": COLORS[leg], "contact": contacts[leg], "foot": self.foot(leg).tolist(),
                "active": asdict(active) if active else None,
                "last": asdict(previous) if previous else None,
                "progress": active.progress(self.tick) if active else 0,
                "remaining_s": max(0, active.planned_end_tick - self.tick) * CONTROL_DT if active else 0,
            }
        return {"tick": self.tick, "sim_time": self.tick * CONTROL_DT, "control_dt": CONTROL_DT,
                "decision_ticks": DECISION_TICKS, "backend": self.backend, "rig": self.rig, "fallen": self.fallen,
                "body_height": float(self.data.qpos[2]), "body_position": self.data.qpos[:3].tolist(),
                "com": com.tolist(), "support_polygon": polygon(support).tolist(),
                "support_margin": support_margin(com, support),
                "body_tilt_deg": math.degrees(math.acos(float(np.clip(rotation[2, 2], -1, 1)))),
                "crawl": self.crawl.telemetry(self) if self.crawl is not None else None,
                "legs": legs, "history": [asdict(m) for m in self.history[-12:]]}

    def checkpoint(self) -> dict:
        if self.backend != "native":
            raise ValueError("Exact checkpoint continuation currently supports the native backend")
        spec = mujoco.mjtState.mjSTATE_INTEGRATION
        state = np.empty(mujoco.mj_stateSize(self.model, spec))
        mujoco.mj_getState(self.model, self.data, state, spec)
        return {"version": 1, "backend": self.backend, "rig": self.rig, "mujoco_version": mujoco.__version__,
                "tick": self.tick, "sequence": self.sequence, "physics": state.tolist(),
                "targets": self.targets.tolist(), "fallen": self.fallen,
                "active": [asdict(m) for m in self.active.values()],
                "history": [asdict(m) for m in self.history],
                "crawl": self.crawl.snapshot() if self.crawl is not None else None,
                "anchors": {leg: value.tolist() for leg, value in self.anchors.items()}}

    def restore(self, checkpoint: dict) -> None:
        if checkpoint["version"] != 1 or checkpoint["backend"] != self.backend or checkpoint["mujoco_version"] != mujoco.__version__:
            raise ValueError("Checkpoint backend/version mismatch")
        if self.backend != "native":
            raise ValueError("MJX checkpoint restore is not implemented")
        mujoco.mj_setState(self.model, self.data, np.array(checkpoint["physics"]), mujoco.mjtState.mjSTATE_INTEGRATION)
        mujoco.mj_forward(self.model, self.data)
        self.tick, self.sequence = checkpoint["tick"], checkpoint["sequence"]
        self.rig = checkpoint["rig"]
        self.targets = np.array(checkpoint["targets"])
        self.fallen = checkpoint["fallen"]
        self.active = {value["leg"]: Motion(**value) for value in checkpoint["active"]}
        self.history = [Motion(**value) for value in checkpoint["history"]]
        self.anchors = {leg: np.array(value) for leg, value in checkpoint["anchors"].items()}
        from .trot import TrotController
        controller = TrotController if (checkpoint.get('crawl') or {}).get('policy') == 'trot' else CrawlController
        self.crawl = controller(self, saved=checkpoint["crawl"]) if checkpoint.get("crawl") else None
