"""Experimental periodic gait executor and measured contact evaluator.

The model selects a small parameter vector. A deterministic centroidal MPC runs
at 25 Hz and leg IK at 50 Hz, using only the stock position actuators. This is a
separate experimental executor: the production paired Ranger barrier cannot fly.
"""
from dataclasses import asdict, dataclass
import math

import mujoco
import numpy as np
from scipy.optimize import nnls

from .crawl import skew
from .model import LEGS
from .motions import smoothstep
from .simulation import Simulation

VERSION = "centroidal-1"
DT = .02
START = .6
BOUNDS = {
    "period": (.32, .70), "duty": (.5, .8), "vx": (.1, .4),
    "height": (.25, .32), "clearance": (.03, .08), "stance_kp": (3., 20.),
    "zweight": (150., 1000.), "pitchweight": (100., 600.),
    "velocityweight": (5., 40.), "placement_gain": (0., .1),
    "regularization": (.0002, .005),
}


@dataclass(frozen=True)
class Gait:
    period: float = .5
    duty: float = .75
    vx: float = .2
    height: float = .3
    clearance: float = .05
    stance_kp: float = 5.
    zweight: float = 500.
    pitchweight: float = 300.
    velocityweight: float = 10.
    placement_gain: float = .05
    regularization: float = .0005
    # FR, FL, RR, RL. phase=(elapsed/period + offset) % 1; swing >= duty.
    offsets: tuple[float, ...] = (0., 0., .5, .5)

    def __post_init__(self):
        for name, (low, high) in BOUNDS.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                raise ValueError(f"{name} must be finite and in [{low}, {high}]")
        if len(self.offsets) != 4 or any(isinstance(x, bool) or not isinstance(x, (int, float))
                                        or not 0 <= x < 1 for x in self.offsets):
            raise ValueError("offsets must contain FR, FL, RR, RL phases in [0, 1)")
        if self.offsets[0] != 0:
            raise ValueError("FR offset must be zero (phase reference)")
        object.__setattr__(self, "offsets", tuple(self.offsets))

    def to_dict(self):
        return asdict(self)

    def phase(self, leg, t):
        return ((t - START) / self.period + self.offsets[LEGS.index(leg)]) % 1

    def swinging(self, leg, t):
        return t >= START and self.phase(leg, t) >= self.duty

    def for_leg(self, leg):
        return self

    def foot_bias(self, leg):
        return np.zeros(2)


class PeriodicController:
    """Receding-horizon force allocation plus world-anchored swing trajectories."""
    def __init__(self, sim, gait):
        self.sim, self.gait = sim, gait
        m, d = sim.model, sim.data
        self.reference = mujoco.MjData(m)
        self.jacobian = np.zeros((3, m.nv))
        self.joints = d.qpos[7:].copy()
        self.nominal = {leg: sim.foot(leg).copy() - d.subtree_com[sim.trunk] for leg in LEGS}
        self.anchors = {leg: sim.foot(leg).copy() for leg in LEGS}
        self.plans = {}
        self.previous = dict.fromkeys(LEGS, False)
        self.forces = np.zeros((4, 3))
        self.dt, self.horizon = .04, 16
        self.rays = np.array([[.4, .4, -.4, -.4], [.4, -.4, .4, -.4], [1, 1, 1, 1]])
        mass = m.body_subtreemass[sim.trunk]
        mass_matrix = np.zeros((m.nv, m.nv))
        mujoco.mj_fullM(m, d, mass_matrix)
        inertia = mass_matrix[3:6, 3:6]
        dt = self.dt
        self.A = np.eye(12)
        self.A[:3, 3:6] = self.A[6:9, 9:12] = dt * np.eye(3)
        self.G = np.zeros(12)
        self.G[2], self.G[5] = -.5 * 9.81 * dt * dt, -9.81 * dt
        self.Q = np.diag(np.sqrt([5, 40, gait.zweight, gait.velocityweight, 10, 5,
                                 300, gait.pitchweight, 100, 2, 2, 2]))
        self.B = np.zeros((12, 16))
        for i, leg in enumerate(LEGS):
            arm = self.nominal[leg].copy()
            arm[2] = -.25
            angular_map = np.linalg.solve(inertia, skew(arm)) @ self.rays
            sl = slice(i * 4, i * 4 + 4)
            self.B[:3, sl] = .5 * dt * dt * self.rays / mass
            self.B[3:6, sl] = dt * self.rays / mass
            self.B[6:9, sl] = .5 * dt * dt * angular_map
            self.B[9:12, sl] = dt * angular_map
        self.regularizer = gait.regularization * np.eye(self.horizon * 16)
        self.matrix_cache = {}

    def _forces(self, t, com, velocity, angles, angular, goal):
        masks = tuple(tuple(not self.gait.swinging(leg, t + k * self.dt) for leg in LEGS)
                      for k in range(self.horizon))
        matrix = self.matrix_cache.get(masks)
        if matrix is None:
            sensitivity = np.zeros((12, self.horizon * 16))
            rows = []
            for k, mask in enumerate(masks):
                sensitivity = self.A @ sensitivity
                sensitivity[:, k * 16:(k + 1) * 16] += self.B * np.repeat(mask, 4)
                rows.append(self.Q @ sensitivity)
            matrix = np.vstack([*rows, self.regularizer])
            if len(self.matrix_cache) < 128:
                self.matrix_cache[masks] = matrix
        free = np.r_[com, velocity, angles, angular]
        rhs = []
        for k in range(self.horizon):
            free = self.A @ free + self.G
            desired = np.r_[com[0] + goal[0] * (k + 1) * self.dt, 0, self.gait.height - .02,
                            goal, np.zeros(6)]
            rhs.append(self.Q @ (desired - free))
        coefficients = nnls(matrix, np.r_[np.concatenate(rhs), np.zeros(self.horizon * 16)],
                            maxiter=5000)[0]
        return coefficients[:16].reshape(4, 4) @ self.rays.T

    def step(self):
        s, p = self.sim, self.gait
        m, d = s.model, s.data
        t = s.tick * DT
        rotation = d.xmat[s.trunk].reshape(3, 3)
        angles = np.array([math.atan2(rotation[2, 1], rotation[2, 2]),
                           math.atan2(-rotation[2, 0], math.hypot(rotation[0, 0], rotation[1, 0])),
                           math.atan2(rotation[1, 0], rotation[0, 0])])
        com = d.subtree_com[s.trunk].copy()
        goal = np.array([p.vx * min(1, max(0, t - START) / .5), 0, 0])
        moving = {leg: p.swinging(leg, t) for leg in LEGS}
        for leg in LEGS:
            local = p.for_leg(leg)
            if moving[leg] and not self.previous[leg]:
                target = com + self.nominal[leg]
                target[:2] += (d.qvel[:2] * ((1 - local.duty) * p.period + .5 * local.duty * p.period)
                               + local.placement_gain * (d.qvel[:2] - goal[:2]) + p.foot_bias(leg))
                target[2] = .020
                self.plans[leg] = s.foot(leg).copy(), target
            elif not moving[leg] and self.previous[leg]:
                self.anchors[leg] = self.plans[leg][1].copy()
            self.previous[leg] = moving[leg]
        if s.tick % 2 == 0:
            self.forces = self._forces(t, com, d.qvel[:3], angles, rotation @ d.qvel[3:6], goal)
        ref = self.reference
        ref.qpos[:] = d.qpos
        ref.qpos[2], ref.qpos[3:7] = p.height, [1, 0, 0, 0]
        for i, leg in enumerate(LEGS):
            local = p.for_leg(leg)
            ids, dofs, qids = s.ik.actuators[leg], s.ik.dofs[leg], s.ik.qids[leg]
            if moving[leg]:
                progress = (p.phase(leg, t) - local.duty) / (1 - local.duty)
                start, end = self.plans[leg]
                target = start + smoothstep(progress) * (end - start)
                target[2] += local.clearance * math.sin(math.pi * progress) ** 2
            else:
                target = self.anchors[leg]
            joint_angles, _ = s.ik.solve(d if moving[leg] else ref, leg, target, self.joints[ids])
            self.joints[ids] = joint_angles
            torque = d.qfrc_bias[dofs].copy()
            if moving[leg]:
                torque += 45 * (joint_angles - d.qpos[qids])
            else:
                mujoco.mj_jacSite(m, d, self.jacobian, None, s.ik.sites[leg])
                torque -= self.jacobian[:, dofs].T @ self.forces[i]
                torque += p.stance_kp * (joint_angles - d.qpos[qids]) - .5 * d.qvel[dofs]
            d.ctrl[ids] = np.clip(d.qpos[qids] + torque / m.actuator_gainprm[ids, 0],
                                  m.actuator_ctrlrange[ids, 0], m.actuator_ctrlrange[ids, 1])
        for _ in range(s.nsubsteps):
            mujoco.mj_step(m, d)
        mujoco.mj_forward(m, d)
        s.tick += 1


def contact_metrics(times, contacts, period):
    """Debounce contact edges; distinguish measured four-beat cycles from bounds.

    A cycle is an FR touchdown to the next FR touchdown. All four legs must
    land exactly once; front and rear pairs must be adjacent in cyclic order.
    Four-beat requires both within-pair separations >= 20ms. Require repeated
    cycles and real >=40ms aerial intervals separately when accepting a gait.
    """
    events = {leg: [] for leg in LEGS}
    air_seconds = {leg: 0. for leg in LEGS}
    stable, pending, counts = [True] * 4, [True] * 4, [0] * 4
    flight_runs, flight = [], 0
    for t, row in zip(times, contacts):
        if t < 1.6:
            continue
        flight = flight + 1 if not any(row) else 0
        if not any(row):
            pass
        elif flight_runs and flight_runs[-1][1] is None:
            flight_runs[-1][1] = float(t)
        if flight == 1:
            flight_runs.append([float(t), None])
        for i, leg in enumerate(LEGS):
            value = bool(row[i])
            air_seconds[leg] += DT * (not value)
            counts[i] = counts[i] + 1 if pending[i] == value else 1
            pending[i] = value
            if counts[i] >= 2 and stable[i] != value:
                stable[i] = value
                if value:
                    events[leg].append(round(float(t - DT), 6))
    flight_lengths = [round((end if end is not None else float(times[-1]) + DT) - start, 6)
                      for start, end in flight_runs]
    cycles = []
    for start, end in zip(events['FR'], events['FR'][1:]):
        if not .6 * period <= end - start <= 1.4 * period:
            continue
        landings = {'FR': [start]}
        landings.update({leg: [x for x in events[leg] if start <= x < end] for leg in LEGS[1:]})
        if any(len(x) != 1 for x in landings.values()):
            continue
        offsets = {leg: values[0] - start for leg, values in landings.items()}
        order = sorted(LEGS, key=lambda leg: offsets[leg])
        groups = [leg[0] for leg in order]
        adjacent = sum(groups[i] != groups[(i + 1) % 4] for i in range(4)) == 2
        duration = end - start
        front = min(abs(offsets['FL']), duration - abs(offsets['FL']))
        rear_gap = abs(offsets['RR'] - offsets['RL'])
        rear = min(rear_gap, duration - rear_gap)
        four_beat = adjacent and front >= .019 and rear >= .019
        cycles.append({"start": start, "duration": round(duration, 6), "order": order,
                       "front_split_s": round(front, 6), "rear_split_s": round(rear, 6),
                       "four_beat": four_beat})
    four_beat_count = sum(c['four_beat'] for c in cycles)
    flights = [v for v in flight_lengths if v >= .039]
    return {"touchdowns": events, "air_s": air_seconds, "cycles": cycles,
            "complete_cycles": len(cycles), "four_beat_cycles": four_beat_count,
            "four_beat_fraction": four_beat_count / max(1, len(cycles)),
            "flight_s": round(sum(flight_lengths), 6), "flight_intervals": len(flights),
            "longest_flight_s": max(flight_lengths, default=0)}


def evaluate(gait, seconds=6., seed=0, *, trace_path=None, gif_path=None):
    if not math.isfinite(seconds) or not 2 <= seconds <= 120:
        raise ValueError("Trial duration must be between 2 and 120 seconds")
    sim = Simulation(rig=False)
    sim.data.qvel[:6] = np.random.default_rng(seed).normal(0, .01, 6)
    controller = PeriodicController(sim, gait)
    rows, frames = [], []
    view = None
    if gif_path:
        from .rendering import View
        view = View(sim)
    failure = None
    try:
        for _ in range(round(seconds / DT)):
            try:
                controller.step()
            except (RuntimeError, np.linalg.LinAlgError):
                failure = "optimizer_failed"
                break
            d, m = sim.data, sim.model
            rotation = d.xmat[sim.trunk].reshape(3, 3)
            tilt = math.degrees(math.acos(float(np.clip(rotation[2, 2], -1, 1))))
            contacts = sim.contacts()
            saturation = np.mean(np.abs(d.actuator_force) >= .98 * m.actuator_forcerange[:, 1])
            rows.append([sim.tick * DT, *d.qpos[:3], tilt, math.degrees(math.atan2(rotation[1, 0], rotation[0, 0])),
                         saturation, *[int(contacts[leg]) for leg in LEGS]])
            if view and sim.tick % 2 == 0:
                frames.append(view.frame().resize((640, 400)))
            if not np.isfinite(d.qpos).all() or d.qpos[2] < .13 or tilt > 50:
                failure = "fell"
                break
    finally:
        if view:
            view.close()
    if not rows:
        raise RuntimeError("Controller failed before producing a simulation step")
    array = np.asarray(rows)
    steady = array[array[:, 0] >= 1.6]
    speed = float(np.polyfit(steady[:, 0], steady[:, 1], 1)[0]) if len(steady) > 5 else 0.
    measured = contact_metrics(array[:, 0], array[:, 7:].astype(bool), gait.period)
    healthy = (failure is None and array[:, 3].min() > .18 and array[:, 4].max() < 25
               and np.abs(array[:, 2]).max() < .25 and np.abs(array[:, 5]).max() < 20)
    galloping = (healthy and measured['four_beat_cycles'] >= 3 and measured['four_beat_fraction'] >= .6
                 and measured['flight_intervals'] >= 2 and speed > .08)
    result = {"controller": VERSION, "gait": gait.to_dict(), "seed": seed, "requested_s": seconds,
              "elapsed_s": sim.tick * DT, "failure": failure, "healthy": bool(healthy),
              "measured_gallop": bool(galloping), "speed_m_s": speed, "distance_m": float(array[-1, 1] - array[0, 1]),
              "max_tilt_deg": float(array[:, 4].max()), "min_height_m": float(array[:, 3].min()),
              "max_abs_yaw_deg": float(np.abs(array[:, 5]).max()), "lateral_drift_m": float(array[-1, 2]),
              "torque_saturation_fraction": float(array[:, 6].mean()), **measured}
    if trace_path:
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(trace_path, samples=array, columns=np.array(
            ['t', 'x', 'y', 'z', 'tilt_deg', 'yaw_deg', 'saturation', *LEGS]))
    if gif_path and frames:
        gif_path.parent.mkdir(parents=True, exist_ok=True)
        frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=40, loop=0)
    return result


def compact(result):
    return {k: v for k, v in result.items() if k not in {'cycles', 'touchdowns'}}


def score(results):
    """Falls dominate; verified four-beat flight outranks raw speed."""
    if not all(r['healthy'] for r in results):
        return -10 + min(r['elapsed_s'] / r['requested_s'] for r in results)
    return (min(r['speed_m_s'] for r in results)
            + .3 * min(r['four_beat_fraction'] for r in results)
            + .5 * all(r['measured_gallop'] for r in results)
            - .001 * max(r['max_tilt_deg'] for r in results))
