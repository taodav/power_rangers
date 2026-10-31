"""Serializable actions. All timing is in simulation control ticks."""

from dataclasses import asdict, dataclass

import numpy as np

CONTROL_DT = 0.02
DECISION_TICKS = 5


def smoothstep(t: float) -> float:
    t = float(np.clip(t, 0, 1))
    return t * t * t * (10 + t * (-15 + 6 * t))


@dataclass
class Motion:
    action_id: str
    leg: str
    primitive: str
    start_tick: int
    duration_ticks: int
    deadline_tick: int
    origin: list[float]
    target: list[float]
    clearance: float = 0.04
    status: str = "running"
    phase: str = "lift"
    saw_air: bool = False
    contact_ticks: int = 0
    end_tick: int | None = None
    reason: str | None = None
    max_clearance: float = 0.0

    @property
    def planned_end_tick(self) -> int:
        return self.start_tick + self.duration_ticks

    def progress(self, tick: int) -> float:
        return min(1.0, max(0.0, (tick - self.start_tick) / self.duration_ticks))

    def desired_foot(self, tick: int) -> np.ndarray:
        u = self.progress(tick)
        origin, target = np.array(self.origin), np.array(self.target)
        if self.primitive == "support":
            self.phase = "support"
            return target
        if self.primitive == "push":
            self.phase = "push"
            return origin + smoothstep(u) * (target - origin)
        # Separate lift, travel, and landing phases with zero endpoint velocity.
        if u < 0.25:
            self.phase = "lift"
            point = origin.copy()
            point[2] += self.clearance * smoothstep(u / 0.25)
        elif u < 0.7:
            self.phase = "swing"
            point = origin + smoothstep((u - 0.25) / 0.45) * (target - origin)
            point[2] = max(origin[2], target[2]) + self.clearance
        else:
            self.phase = "land"
            point = target.copy()
            top = max(origin[2], target[2]) + self.clearance
            point[2] = top + smoothstep((u - 0.7) / 0.3) * (target[2] - top)
            # A bounded landing search after nominal completion.
            point[2] -= min(0.025, max(0, tick - self.planned_end_tick) * CONTROL_DT * 0.06)
        return point

    def observe(self, tick: int, contact: bool, foot_height: float) -> bool:
        if self.status != "running":
            return False
        self.max_clearance = max(self.max_clearance, foot_height - self.origin[2])
        if self.primitive == "swing_to":
            self.saw_air |= not contact
            self.contact_ticks = self.contact_ticks + 1 if contact and self.saw_air else 0
            if self.progress(tick) >= 0.7 and self.saw_air and self.contact_ticks >= 3:
                self.finish(tick, "completed", "touchdown confirmed")
            elif tick >= self.deadline_tick:
                self.finish(tick, "failed", "no touchdown" if self.saw_air else "failed to lift")
        elif not contact:
            self.contact_ticks += 1
            if self.contact_ticks >= 5:
                self.finish(tick, "failed", "lost contact")
        else:
            self.contact_ticks = 0
            if tick >= self.planned_end_tick:
                self.finish(tick, "completed", "duration elapsed")
        return self.status != "running"

    def finish(self, tick: int, status: str, reason: str) -> None:
        self.status, self.reason, self.end_tick, self.phase = status, reason, tick, status

    def to_dict(self) -> dict:
        return asdict(self)
