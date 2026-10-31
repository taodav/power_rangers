"""Four independent Rangers in ONE authoritative MuJoCo model and data object.

Each controller writes only its own actuators. All robot/object contacts are
resolved together by one integration loop. The first workspaces are separated;
this is not yet a navigation policy or cooperative construction skill.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("herd_ranger", Path(__file__).with_name("ranger.py"))
ranger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ranger)
mujoco, np, DT = ranger.mujoco, ranger.np, ranger.DT
ORIGINS = ((-2., -2.), (1., -2.), (-2., 1.), (1., 1.))
COLORS = (".85 .25 .18 1", ".25 .48 .85 1", ".88 .65 .2 1", ".25 .65 .45 1")


def model_xml(origins=ORIGINS):
    if np.array(origins).shape != (4, 2) or not np.isfinite(origins).all():
        raise ValueError("Four finite workspace origins are required")
    source = ET.fromstring(ranger.model_xml())
    root = copy.deepcopy(source)
    root.set("model", "four_independent_physical_rangers")
    world, actuators, contact = (root.find(tag) for tag in ("worldbody", "actuator", "contact"))
    for child in list(world):
        if child.get("name") != "floor":
            world.remove(child)
    actuators.clear()
    contact.clear()
    for slot, (x, y) in enumerate(origins):
        prefix = f"r{slot}_"
        module = copy.deepcopy(source)
        for element in module.iter():
            for attribute in ("name", "joint", "body1", "body2"):
                value = element.get(attribute)
                if value and value != "floor":
                    element.set(attribute, prefix+value)
            if element.tag == "geom" and any(word in element.get("name", "") for word in ("thigh_armor", "shin_stripe", "upper_arm_armor", "forearm_armor", "sole")):
                element.set("rgba", COLORS[slot])
        for child in module.find("worldbody"):
            if child.get("name") == "floor":
                continue
            position = np.fromstring(child.get("pos", "0 0 0"), sep=" ")
            position[:2] += (x, y)
            child.set("pos", " ".join(str(v) for v in position))
            world.append(child)
        actuators.extend(module.find("actuator"))
        contact.extend(module.find("contact"))
    return ET.tostring(root, encoding="unicode")


class Herd:
    def __init__(self, origins=ORIGINS):
        self.model = mujoco.MjModel.from_xml_string(model_xml(origins))
        self.data = mujoco.MjData(self.model)
        self.controllers = [ranger.Ranger(delivery=True, model=self.model, data=self.data,
                                         prefix=f"r{slot}_", owner_slot=slot,
                                         destination=ranger.DESTINATION+np.array([x, y, 0.]))
                            for slot, (x, y) in enumerate(origins)]
        roots = {controller.pelvis for controller in self.controllers}
        for controller in self.controllers:
            controller.robot_roots = roots
        self.owners = {}
        for slot in range(4):
            for actuator in range(self.model.nu):
                if self.model.actuator(actuator).name.startswith(f"r{slot}_"):
                    self.owners[actuator] = slot
        if len(self.owners) != self.model.nu:
            raise ValueError("Every actuator needs exactly one hardware owner")
        self.tick, self.failed = 0, ""
        self.authorized = False

    def authorize(self, jobs):
        """Apply only a complete validated batch; durable actor calls belong to the adapter."""
        if self.authorized or self.failed or self.tick < 150:
            raise ValueError("Authorize once after the shared world has settled")
        if not isinstance(jobs, list) or len(jobs) != 4:
            raise ValueError("Exactly four owned jobs are required")
        seen, job_ids = set(), set()
        for job in jobs:
            if not isinstance(job, dict):
                raise ValueError("An owned job must be an object")
            slot, job_id = job.get("ownerSlot"), job.get("jobId")
            if type(slot) is not int or slot not in range(4) or slot in seen:
                raise ValueError("Each hardware slot must authorize exactly once")
            if not isinstance(job_id, str) or not job_id.isascii() or not 1 <= len(job_id) <= 80 or not all(c.isalnum() or c in "-_" for c in job_id) or job_id in job_ids:
                raise ValueError("Use distinct bounded job IDs")
            if job.get("objectId") != f"cargo-{slot}" or job.get("destinationId") != f"station-{slot+1}":
                raise ValueError("A job cannot claim another Ranger's assigned cargo or destination")
            if self.controllers[slot].job != "idle":
                raise ValueError("All controllers must be idle before the batch starts")
            seen.add(slot)
            job_ids.add(job_id)
        for job in jobs:
            self.controllers[job["ownerSlot"]].start_job(job["jobId"])
        self.authorized = True

    def step(self, ticks=1):
        if type(ticks) is not int or not 1 <= ticks <= 50:
            raise ValueError("Advance 1–50 bounded shared control ticks")
        for _ in range(ticks):
            if self.failed:
                return
            for controller in self.controllers:
                if controller.failed or controller.awaiting:
                    self.failed = "A controller failed or unexpectedly awaits a limb plan"
                    return
                before = self.data.ctrl.copy()
                controller.phase_ticks[controller.phase] += 1
                controller.control()
                foreign = [a for a, slot in self.owners.items() if slot != controller.owner_slot]
                if not np.array_equal(before[foreign], self.data.ctrl[foreign]):
                    self.failed = "A controller wrote another Ranger's actuators"
                    return
                if controller.failed:
                    self.failed = f"Ranger {controller.owner_slot}: {controller.failed}"
                    return
            # Critically: not controller.step(). Four controllers share these five integrator calls.
            for _ in range(5):
                mujoco.mj_step(self.model, self.data)
            mujoco.mj_forward(self.model, self.data)
            self.tick += 1
            for controller in self.controllers:
                controller.observe_step()
                if controller.failed:
                    self.failed = f"Ranger {controller.owner_slot}: {controller.failed}"

    def state(self, geometry=False):
        states = [controller.state() for controller in self.controllers]
        result = {"tick": self.tick, "time": self.tick*DT, "physics_time": float(self.data.time),
                  "failed": self.failed, "authorized": self.authorized,
                  "complete": all(s["job"] == "complete" and s["objects"][0]["placed"] for s in states),
                  "rangers": states, "objects": [s["objects"][0] for s in states],
                  "actuator_owners": [self.owners[a] for a in range(self.model.nu)],
                  "actor_bindings": None,
                  "boundary": "One shared physics world; four fixed delivery workspaces, not shared building or crash recovery."}
        if geometry:
            result["geoms"] = self.controllers[0].state(geometry=True)["geoms"]
        return result


def trial(seconds=55):
    if not 0 < seconds <= 90:
        raise ValueError("Use at most 90 simulated seconds")
    world, started = Herd(), time.monotonic()
    for _ in range(3):
        world.step(50)
    world.authorize([{"ownerSlot": slot, "jobId": f"numeric-trial-{slot}", "objectId": f"cargo-{slot}",
                      "destinationId": f"station-{slot+1}"} for slot in range(4)])
    for _ in range(round(seconds/DT)):
        if time.monotonic()-started > 240:
            raise TimeoutError("Shared native trial exceeded its inner wall-clock bound")
        world.step()
        if world.failed or all(controller.job == "complete" for controller in world.controllers):
            break
    return world.state()


if __name__ == "__main__":
    if "--worker" in sys.argv:
        world = Herd()
        while line := sys.stdin.readline(4097):
            if len(line) > 4096:
                print(json.dumps({"ok": False, "error": "Small worker command required"}), flush=True)
                break
            try:
                command = json.loads(line)
                if command["command"] == "step":
                    world.step(command.get("ticks", 1))
                elif command["command"] == "authorize":
                    world.authorize(command["jobs"])
                elif command["command"] != "state":
                    raise ValueError("Unknown shared-world command")
                print(json.dumps({"ok": True, "state": world.state(geometry=True)}), flush=True)
            except Exception:
                print(json.dumps({"ok": False, "error": "Shared-world command refused"}), flush=True)
    else:
        seconds = float(sys.argv[sys.argv.index("--trial")+1]) if "--trial" in sys.argv else 55.
        result = trial(seconds)
        print(json.dumps(result))
        if result["failed"] or not result["complete"]:
            raise SystemExit(2)
