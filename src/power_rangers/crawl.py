"""Slow contact-gated crawl and actuator-only stance control on flat ground.

The stance controller requests a centroidal wrench and allocates nonnegative
ground forces within a conservative friction pyramid. J.T maps these forces
to joint torques; the stock position actuators deliver those torques via target
offsets. No force is applied to the trunk and the calibration weld stays off.
"""

from dataclasses import asdict, dataclass, field
import math
from typing import TYPE_CHECKING

import mujoco
import numpy as np
from scipy.optimize import nnls

from .model import LEGS
from .motions import CONTROL_DT, smoothstep

if TYPE_CHECKING:
    from .simulation import Simulation

ORDER = ("RL", "FL", "RR", "FR")
SHIFT_TICKS = 60
SETTLE_TICKS = 15
SWING_SECONDS = 0.7
STRIDE = 0.05


def polygon(points: np.ndarray) -> np.ndarray:
    """Order our three/four foot points counterclockwise."""
    if len(points) < 3:
        return points
    center = points.mean(axis=0)
    return points[np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))]


def support_margin(point: np.ndarray, feet: np.ndarray) -> float:
    """Signed distance to the closest support-polygon edge; negative outside."""
    if len(feet) < 3:
        return -1.0
    vertices = polygon(np.asarray(feet)[:, :2])
    edges = np.roll(vertices, -1, axis=0) - vertices
    relative = np.asarray(point)[:2] - vertices
    lengths = np.linalg.norm(edges, axis=1)
    if min(lengths) < 1e-8:
        return -1.0
    return float(np.min((edges[:, 0] * relative[:, 1] - edges[:, 1] * relative[:, 0]) / lengths))


def skew(r: np.ndarray) -> np.ndarray:
    x, y, z = r
    return np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])


@dataclass
class CrawlState:
    cycles: int
    start_tick: int
    start_position: list[float]
    body_target: list[float]
    shift_origin: list[float]
    shift_target: list[float]
    previous_com: list[float]
    joint_targets: list[float]
    heading: list[float]
    quaternion: list[float]
    com_offset: list[float]
    status: str = "running"
    phase: str = "weight_shift"
    phase_start: int = 0
    completed_steps: int = 0
    ready_ticks: int = 0
    motion_id: str | None = None
    stop_requested: bool = False
    reason: str | None = None
    end_tick: int | None = None
    min_height: float = 1.0
    max_tilt_deg: float = 0.0
    events: list[dict] = field(default_factory=list)
    external_policy: bool = False
    selected_leg: str | None = None
    stride: float = STRIDE
    swing_seconds: float = SWING_SECONDS
    clearance: float = 0.035
    intent_id: str | None = None
    policy: str = "fixed"
    goal: dict = field(default_factory=lambda: {"vx": 0.01, "vy": 0.0, "yaw_rate": 0.0})
    profile: str = "baseline"
    shift_ticks: int = SHIFT_TICKS
    settle_ticks: int = SETTLE_TICKS
    foot_target: list[float] | None = None
    nominal_feet: dict = field(default_factory=dict)
    yaw_origin: float = 0.0
    yaw_target: float = 0.0
    initial_yaw: float = 0.0
    measured_yaw: float = 0.0
    yaw_travel: float = 0.0
    hold_until: int = 0
    held_goal: dict = field(default_factory=dict)
    mechanical_work: float = 0.0
    tracking_error_integral: float = 0.0
    steady_tick: int | None = None
    steady_position: list[float] | None = None
    reference_center: list[float] = field(default_factory=list)
    reference_yaw: float = 0.0
    reference_goal: dict = field(default_factory=dict)
    selected_legs: list[str] = field(default_factory=list)
    batch_intents: list[dict] = field(default_factory=list)
    motion_ids: list[str] = field(default_factory=list)
    next_pair: int = 0
    concurrent_swing_ticks: int = 0
    concurrent_air_ticks: int = 0
    max_concurrent_swings: int = 0


class CrawlController:
    def __init__(self, sim: "Simulation", cycles: int = 3, saved: dict | None = None, external_policy: bool = False):
        self.reference = mujoco.MjData(sim.model)
        self.jacobian = np.zeros((3, sim.model.nv))
        if saved is not None:
            self.state = CrawlState(**saved)
            if not self.state.nominal_feet:
                yaw = math.atan2(self.state.heading[1], self.state.heading[0])
                self.state.initial_yaw = yaw
                center = np.mean([sim.anchors[leg][:2] for leg in LEGS], axis=0)
                inverse = np.array([[math.cos(yaw), math.sin(yaw)], [-math.sin(yaw), math.cos(yaw)]])
                self.state.nominal_feet = {leg: (inverse @ (sim.anchors[leg][:2] - center)).tolist() for leg in LEGS}
            return
        if type(cycles) is not int or not 1 <= cycles <= 20:
            raise ValueError("Crawl cycles must be an integer from 1 to 20")
        rotation = sim.data.xmat[sim.trunk].reshape(3, 3)
        yaw = math.atan2(rotation[1, 0], rotation[0, 0])
        body = sim.data.qpos[:3].copy()
        com = sim.data.subtree_com[sim.trunk].copy()
        self.state = CrawlState(
            cycles=cycles, start_tick=sim.tick, start_position=body.tolist(),
            body_target=body.tolist(), shift_origin=body.tolist(), shift_target=body.tolist(),
            previous_com=com.tolist(), joint_targets=sim.data.qpos[7:].tolist(),
            heading=[math.cos(yaw), math.sin(yaw), 0],
            quaternion=[math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)],
            com_offset=[0, 0, -0.02], phase_start=sim.tick, external_policy=external_policy,
            initial_yaw=yaw, measured_yaw=yaw, yaw_origin=yaw, yaw_target=yaw,
        )
        center = np.mean([sim.foot(leg) for leg in LEGS], axis=0)
        inverse = np.array([[math.cos(yaw), math.sin(yaw)], [-math.sin(yaw), math.cos(yaw)]])
        self.state.nominal_feet = {leg: (inverse @ (sim.foot(leg)[:2] - center[:2])).tolist() for leg in LEGS}
        if external_policy:
            self._event(sim, "awaiting_decision")
        else:
            self._begin_shift(sim)

    @property
    def leg(self) -> str | None:
        if self.state.external_policy:
            return self.state.selected_leg
        return ORDER[self.state.completed_steps % 4]

    def reserve_step(self, sim: "Simulation", intent: dict) -> None:
        """Accept a policy decision; the executor still gates lift on support."""
        if not self.state.external_policy or self.state.phase != "awaiting_decision":
            raise ValueError("Executor is not awaiting a leg decision")
        leg = intent["leg"]
        duration, stride, clearance = (intent[k] for k in ("duration", "forward", "clearance"))
        if leg not in LEGS or not all(math.isfinite(x) for x in (duration, stride, clearance)):
            raise ValueError("Invalid step intent")
        if not (.2 <= duration <= 2 and -.08 <= stride <= .08 and .015 <= clearance <= .08):
            raise ValueError("Step intent exceeds motion limits")
        self.state.selected_leg = leg
        self.state.swing_seconds, self.state.stride, self.state.clearance = duration, stride, clearance
        self.state.intent_id = intent["id"]
        self.state.foot_target = intent.get("target")
        if self.state.foot_target is not None:
            target = np.asarray(self.state.foot_target)
            if target.shape != (3,) or not np.isfinite(target).all() or np.linalg.norm(target - sim.foot(leg)) > .085:
                raise ValueError("Foot target exceeds the 8.5 cm step workspace")
        self.state.shift_ticks = int(intent.get("shift_ticks", SHIFT_TICKS))
        self.state.settle_ticks = int(intent.get("settle_ticks", SETTLE_TICKS))
        if not 20 <= self.state.shift_ticks <= 100 or not 5 <= self.state.settle_ticks <= 30:
            raise ValueError("Invalid support-transfer timing")
        self._begin_shift(sim)

    def reserve_hold(self, sim: "Simulation", ticks: int = 25) -> None:
        if self.state.phase != "awaiting_decision":
            raise ValueError("Executor is not awaiting a decision")
        self.state.selected_leg = None
        self.state.foot_target = None
        self._begin_shift(sim, center=True)
        self.state.hold_until = sim.tick + ticks
        self.state.held_goal = dict(self.state.goal)
        self._event(sim, "goal_hold")

    def formation(self, sim: "Simulation") -> tuple[np.ndarray, float]:
        feet = np.array([sim.anchors[leg][:2] for leg in LEGS])
        center = feet.mean(axis=0)
        nominal = np.array([self.state.nominal_feet[leg] for leg in LEGS])
        relative = feet - center
        dot = float(np.sum(nominal * relative))
        cross = float(np.sum(nominal[:, 0] * relative[:, 1] - nominal[:, 1] * relative[:, 0]))
        return center, math.atan2(cross, dot)

    def sync_goal_reference(self, sim: "Simulation") -> None:
        state = self.state
        if state.policy != "fixed" and (not state.reference_center or state.reference_goal != state.goal):
            center, yaw = self.formation(sim)
            state.reference_center, state.reference_yaw = center.tolist(), yaw
            state.reference_goal = dict(state.goal)

    def _event(self, sim: "Simulation", phase: str) -> None:
        self.state.phase = phase
        self.state.phase_start = sim.tick
        self.state.ready_ticks = 0
        self.state.events.append({"tick": sim.tick, "phase": phase, "leg": self.leg})
        self.state.events = self.state.events[-40:]

    def _begin_shift(self, sim: "Simulation", center: bool = False) -> None:
        state = self.state
        supports = [sim.anchors[leg] for leg in LEGS if center or leg != self.leg]
        state.shift_origin = list(state.body_target)
        target = np.array(state.body_target)
        target[:2] = np.mean(supports, axis=0)[:2]
        target[2] = 0.27
        state.shift_target = target.tolist()
        state.yaw_origin = 2 * math.atan2(state.quaternion[3], state.quaternion[0])
        desired_yaw = self.formation(sim)[1] if state.policy != "fixed" else state.initial_yaw
        delta_yaw = math.atan2(math.sin(desired_yaw - state.yaw_origin), math.cos(desired_yaw - state.yaw_origin))
        state.yaw_target = state.yaw_origin + float(np.clip(delta_yaw, -.12, .12))
        self._event(sim, "recenter" if center else "weight_shift")

    def request_stop(self) -> None:
        self.state.stop_requested = True

    def fail(self, sim: "Simulation", reason: str) -> None:
        self.state.status, self.state.reason, self.state.end_tick = "failed", reason, sim.tick
        self._event(sim, "failed")
        for leg, motion in list(sim.active.items()):
            motion.finish(sim.tick, "failed", reason)
            sim.history.append(motion)
            del sim.active[leg]

    def prepare(self, sim: "Simulation") -> None:
        state = self.state
        if state.status != "running":
            return
        self.sync_goal_reference(sim)
        if state.stop_requested and state.phase in ("weight_shift", "awaiting_decision", "goal_hold"):
            self._begin_shift(sim, center=True)
        elapsed = sim.tick - state.phase_start
        if state.phase == "goal_hold" and (sim.tick >= state.hold_until or state.goal != state.held_goal):
            self._event(sim, "awaiting_decision")
            return
        if state.phase in ("weight_shift", "recenter", "goal_hold"):
            fraction = smoothstep((elapsed + 1) / state.shift_ticks)
            state.body_target = (np.array(state.shift_origin) + fraction * (np.array(state.shift_target) - state.shift_origin)).tolist()
            yaw = state.yaw_origin + fraction * (state.yaw_target - state.yaw_origin)
            state.quaternion = [math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)]
            if state.phase == "goal_hold":
                return
            contact = sim.contacts()
            support_legs = list(LEGS) if state.phase == "recenter" else [leg for leg in LEGS if leg != self.leg]
            margin = support_margin(sim.data.subtree_com[sim.trunk], np.array([sim.foot(leg) for leg in support_legs]))
            ready = (elapsed >= state.shift_ticks and all(contact.values()) and margin > 0.015
                     and np.linalg.norm(sim.data.qvel[:2]) < 0.10
                     and np.linalg.norm(sim.data.subtree_com[sim.trunk][:2] - np.array(state.body_target)[:2]) < 0.025)
            state.ready_ticks = state.ready_ticks + 1 if ready else 0
            if state.ready_ticks >= 3:
                if state.phase == "recenter":
                    state.status = "stopped" if state.stop_requested else "completed"
                    state.end_tick = sim.tick
                    self._event(sim, "holding")
                else:
                    motion = sim._start_motion(self.leg, duration=state.swing_seconds, forward=state.stride, clearance=state.clearance)
                    motion.target = (state.foot_target or (np.array(motion.origin) + np.array(state.heading) * state.stride).tolist())
                    if state.intent_id:
                        motion.action_id = state.intent_id
                    state.motion_id = motion.action_id
                    self._event(sim, "swing")
            elif elapsed >= 180:
                self.fail(sim, "weight shift timed out before stable support")
        elif state.phase == "touchdown":
            state.ready_ticks = state.ready_ticks + 1 if all(sim.contacts().values()) else 0
            if elapsed >= state.settle_ticks and state.ready_ticks >= 3:
                if state.stop_requested or state.completed_steps >= state.cycles * 4:
                    self._begin_shift(sim, center=True)
                elif state.external_policy:
                    self.state.selected_leg = None
                    self._event(sim, "awaiting_decision")
                else:
                    self._begin_shift(sim)
            elif elapsed >= 75:
                self.fail(sim, "support transfer timed out")

    def apply(self, sim: "Simulation") -> None:
        state = self.state
        com = sim.data.subtree_com[sim.trunk].copy()
        velocity = (com - np.array(state.previous_com)) / CONTROL_DT
        state.previous_com = com.tolist()
        body_target = np.array(state.body_target)
        desired_com = body_target + np.array(state.com_offset)
        mass = sim.model.body_subtreemass[sim.trunk]
        force = mass * (60 * (desired_com - com) - 15 * velocity - sim.model.opt.gravity)
        rotation = sim.data.xmat[sim.trunk].reshape(3, 3)
        angular_velocity = rotation @ sim.data.qvel[3:6]
        # World-frame rotation error from current orientation to target yaw.
        conjugate = sim.data.qpos[3:7].copy()
        conjugate[1:] *= -1
        error_quat = np.zeros(4)
        mujoco.mju_mulQuat(error_quat, np.array(state.quaternion), conjugate)
        torque = 35 * 2 * np.sign(error_quat[0]) * error_quat[1:] - 2 * angular_velocity

        swinging = set(sim.active) if state.phase in ("swing", "pair_swing") else set()
        stance = [leg for leg in LEGS if leg not in swinging]
        matrix = np.concatenate([np.vstack([np.eye(3), skew(sim.foot(leg) - com)]) for leg in stance], axis=1)
        rays = np.array([[.35, .35, -.35, -.35], [.35, -.35, .35, -.35], [1, 1, 1, 1]])
        basis = np.kron(np.eye(len(stance)), rays)
        weights = np.diag([1, 1, 1, 5, 5, 5])
        allocation = weights @ matrix @ basis
        coefficients = nnls(np.vstack([allocation, .03 * np.eye(allocation.shape[1])]),
                            np.r_[weights @ np.r_[force, torque], np.zeros(allocation.shape[1])])[0]
        forces = (basis @ coefficients).reshape(-1, 3)

        self.reference.qpos[:] = sim.data.qpos
        self.reference.qpos[:3] = body_target
        self.reference.qpos[3:7] = state.quaternion
        joint_targets = np.array(state.joint_targets)
        for leg in LEGS:
            ids, dofs, qids = sim.ik.actuators[leg], sim.ik.dofs[leg], sim.ik.qids[leg]
            motion = sim.active.get(leg)
            target = motion.desired_foot(sim.tick + 1) if motion else sim.anchors[leg]
            reference = sim.data if leg in swinging else self.reference
            angles, _ = sim.ik.solve(reference, leg, target, joint_targets[ids])
            joint_targets[ids] = angles
            joint_torque = sim.data.qfrc_bias[dofs].copy()
            if leg in stance:
                mujoco.mj_jacSite(sim.model, sim.data, self.jacobian, None, sim.ik.sites[leg])
                joint_torque -= self.jacobian[:, dofs].T @ forces[stance.index(leg)]
                joint_torque += 5 * (angles - sim.data.qpos[qids]) - .5 * sim.data.qvel[dofs]
            else:
                joint_torque += 35 * (angles - sim.data.qpos[qids])
            # The existing actuator enforces its torque and control limits.
            gains = sim.model.actuator_gainprm[ids, 0]
            sim.targets[ids] = np.clip(sim.data.qpos[qids] + joint_torque / gains,
                                       sim.model.actuator_ctrlrange[ids, 0], sim.model.actuator_ctrlrange[ids, 1])
        state.joint_targets = joint_targets.tolist()

    def observe(self, sim: "Simulation") -> None:
        state = self.state
        state.max_concurrent_swings = max(state.max_concurrent_swings, len(sim.active))
        state.concurrent_swing_ticks += int(len(sim.active) >= 2)
        contact = sim.contacts()
        state.concurrent_air_ticks += int(sum(not contact[l] for l in sim.active) >= 2)
        state.min_height = min(state.min_height, float(sim.data.qpos[2]))
        tilt = math.degrees(math.acos(float(np.clip(sim.data.xmat[sim.trunk].reshape(3, 3)[2, 2], -1, 1))))
        state.max_tilt_deg = max(state.max_tilt_deg, tilt)
        yaw = math.atan2(sim.data.xmat[sim.trunk].reshape(3, 3)[1, 0], sim.data.xmat[sim.trunk].reshape(3, 3)[0, 0])
        state.yaw_travel += math.atan2(math.sin(yaw - state.measured_yaw), math.cos(yaw - state.measured_yaw))
        state.measured_yaw = yaw
        state.mechanical_work += float(np.sum(np.abs(sim.data.qfrc_actuator * sim.data.qvel))) * CONTROL_DT
        local_velocity = np.array([[math.cos(yaw), math.sin(yaw)], [-math.sin(yaw), math.cos(yaw)]]) @ sim.data.qvel[:2]
        state.tracking_error_integral += float(np.linalg.norm(local_velocity - [state.goal["vx"], state.goal["vy"]])) * CONTROL_DT
        if state.policy != "fixed" and state.status == "running":
            self.sync_goal_reference(sim)
            center, formation_yaw = self.formation(sim)
            c, s = math.cos(state.reference_yaw), math.sin(state.reference_yaw)
            advance = np.array([c * state.goal["vx"] - s * state.goal["vy"], s * state.goal["vx"] + c * state.goal["vy"]])
            reference = np.array(state.reference_center) + advance * CONTROL_DT
            error = reference - center
            state.reference_center = (center + error * min(1, .04 / max(1e-9, np.linalg.norm(error)))).tolist()
            requested_yaw = state.reference_yaw + state.goal["yaw_rate"] * CONTROL_DT
            error_yaw = math.atan2(math.sin(requested_yaw - formation_yaw), math.cos(requested_yaw - formation_yaw))
            state.reference_yaw = formation_yaw + float(np.clip(error_yaw, -.18, .18))
        if state.status != "running":
            return
        if sim.fallen:
            self.fail(sim, "body fell")
        elif state.phase == "swing" and self.leg not in sim.active:
            motion = next((m for m in reversed(sim.history) if m.action_id == state.motion_id), None)
            if motion is None or motion.status != "completed":
                self.fail(sim, motion.reason if motion else "missing swing result")
            else:
                self._event(sim, "touchdown")
                state.completed_steps += 1
                if state.completed_steps == 4:
                    state.steady_tick = sim.tick
                    state.steady_position = sim.data.qpos[:3].tolist()

    def snapshot(self) -> dict:
        return asdict(self.state)

    def telemetry(self, sim: "Simulation") -> dict:
        state = self.state
        delta = sim.data.qpos[:3] - state.start_position
        elapsed = ((state.end_tick if state.end_tick is not None else sim.tick) - state.start_tick) * CONTROL_DT
        return {"status": state.status, "phase": state.phase, "leg": self.leg,
                "cycles": state.cycles, "completed_steps": state.completed_steps,
                "completed_cycles": state.completed_steps // 4,
                "progress": state.completed_steps / (state.cycles * 4),
                "forward_m": float(delta @ state.heading),
                "lateral_m": float(delta @ np.array([-state.heading[1], state.heading[0], 0])),
                "yaw_deg": math.degrees(state.yaw_travel), "policy": state.policy, "goal": state.goal,
                "profile": state.profile, "mechanical_work_j": state.mechanical_work,
                "selected_legs": state.selected_legs or ([self.leg] if self.leg else []),
                "concurrent_swing_s": state.concurrent_swing_ticks * CONTROL_DT,
                "concurrent_air_s": state.concurrent_air_ticks * CONTROL_DT,
                "max_concurrent_swings": state.max_concurrent_swings,
                "velocity_error_m_s": state.tracking_error_integral / max(CONTROL_DT, elapsed),
                "elapsed_s": elapsed,
                "phase_elapsed_s": (sim.tick - state.phase_start) * CONTROL_DT,
                "body_target": state.body_target, "stop_requested": state.stop_requested,
                "min_height": state.min_height, "max_tilt_deg": state.max_tilt_deg,
                "reason": state.reason, "events": state.events}
