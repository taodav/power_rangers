"""Independent physical Ranger manipulation bench, with no grasp welds.

The only kinematic changes are to scratch IK data. Live robot and object state
are integrated by MuJoCo. This first experiment uses a visible pickup stand.
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("ranger_locomotion", Path(__file__).with_name("megazord.py"))
locomotion = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(locomotion)
mujoco, np = locomotion.mujoco, locomotion.np
DT, SIDES, smooth = locomotion.DT, locomotion.SIDES, locomotion.smooth
ARM_PARTS = ("shoulder_roll", "shoulder", "elbow", "wrist_yaw", "wrist_roll", "wrist")


def model_xml():
    root = ET.fromstring(locomotion.model_xml())
    root.set("model", "independent_ranger_grasp_bench")
    world, actuators = root.find("worldbody"), root.find("actuator")
    for geom in root.findall(".//geom"):
        if any(word in geom.get("name", "") for word in ("thigh_armor", "shin_stripe", "upper_arm_armor", "forearm_armor", "sole")):
            geom.set("rgba", ".85 .25 .18 1")
    for side in SIDES:
        upper = root.find(f".//body[@name='{side}_upper_arm']")
        fore = root.find(f".//body[@name='{side}_forearm']")
        upper.insert(0, ET.Element("joint", name=f"{side}_shoulder_roll", axis="1 0 0", range="-.8 .8"))
        root.find(f".//joint[@name='{side}_shoulder']").set("range", "-1.8 1.2")
        root.find(f".//joint[@name='{side}_elbow']").set("range", "-2.3 .1")
        fore.remove(fore.find(f"geom[@name='{side}_fist']"))
        ET.SubElement(fore, "geom", name=f"{side}_wrist_link", type="box", size=".035 .035 .065", pos="0 0 -.395", mass=".05", rgba=".3 .35 .31 1")
        wrist = ET.SubElement(fore, "body", name=f"{side}_hand", pos="0 0 -.46")
        ET.SubElement(wrist, "joint", name=f"{side}_wrist_yaw", axis="0 0 1", range="-1.5 1.5")
        ET.SubElement(wrist, "joint", name=f"{side}_wrist_roll", axis="1 0 0", range="-1.1 1.1")
        ET.SubElement(wrist, "joint", name=f"{side}_wrist", axis="0 1 0", range="-2.5 2.5")
        ET.SubElement(wrist, "geom", name=f"{side}_palm", type="box", size=".065 .14 .025", mass=".15", rgba=".25 .3 .27 1")
        ET.SubElement(wrist, "site", name=f"{side}_grasp", pos="0 0 -.115", size=".008")
        for index, sign in enumerate((-1, 1)):
            finger = ET.SubElement(wrist, "body", name=f"{side}_finger_{index}", pos=f"0 {sign*.11} -.115")
            name = f"{side}_finger_{index}"
            ET.SubElement(finger, "joint", name=name, type="slide", axis=f"0 {-sign} 0", range="0 .09", damping="2", armature=".001")
            ET.SubElement(finger, "geom", name=name, type="box", size=".055 .018 .09", mass=".05", friction="1.6 .01 .001", rgba=".45 .5 .44 1")
            ET.SubElement(actuators, "position", name=name, joint=name, kp="350", kv="5", forcerange="-12 12")
        for part in ARM_PARTS:
            name = f"{side}_{part}"
            actuator = actuators.find(f"position[@name='{name}']")
            if actuator is None:
                actuator = ET.SubElement(actuators, "position", name=name, joint=name)
            actuator.set("kp", "900")
            actuator.set("kv", "45")
            actuator.set("forcerange", "-80 80" if "wrist" not in part else "-30 30")
    ET.SubElement(world, "geom", name="pickup_stand", type="box", size=".09 .09 .47", pos=".56 .83 .47", rgba=".65 .53 .37 1")
    box = ET.SubElement(world, "body", name="cargo", pos=".56 .83 .995")
    ET.SubElement(box, "freejoint", name="cargo_root")
    ET.SubElement(box, "geom", name="cargo", type="box", size=".05 .05 .05", mass=".12", friction="1.2 .01 .001", rgba=".92 .71 .29 1", condim="4")
    return ET.tostring(root, encoding="unicode")


class Ranger(locomotion.Biped):
    def __init__(self):
        super().__init__(gait="brisk", model_source=model_xml())
        self.arm_joints = {s: np.array([self.model.joint(f"{s}_{p}").id for p in ARM_PARTS]) for s in SIDES}
        self.arm_qids = {s: self.model.jnt_qposadr[j] for s, j in self.arm_joints.items()}
        self.arm_dofs = {s: self.model.jnt_dofadr[j] for s, j in self.arm_joints.items()}
        self.arm_acts = {s: np.array([self.model.actuator(f"{s}_{p}").id for p in ARM_PARTS]) for s in SIDES}
        self.hand_sites = {s: self.model.site(f"{s}_grasp").id for s in SIDES}
        self.fingers = {s: [self.model.geom(f"{s}_finger_{i}").id for i in range(2)] for s in SIDES}
        self.finger_acts = {s: [self.model.actuator(f"{s}_finger_{i}").id for i in range(2)] for s in SIDES}
        self.cargo, self.cargo_geom = self.model.body("cargo").id, self.model.geom("cargo").id
        self.stand_geom = self.model.geom("pickup_stand").id
        self.reset_job_state()

    def reset(self):
        super().reset()
        if hasattr(self, "cargo"):
            self.reset_job_state()

    def reset_job_state(self):
        self.job = "idle"
        self.job_tick = 0
        self.grip_closed = False
        self.hand_target = None
        self.hand_origin = None
        self.body_origin = self.body_target.copy()
        self.body_center = self.body_target.copy()
        self.job_goal_steps = 0
        self.grip_samples = 0
        self.lift_samples = 0
        self.max_lift = 0.
        self.cargo_start = self.data.xpos[self.cargo].copy()
        self.receipts = []

    def grip_contacts(self):
        touches = {i: False for i in self.fingers["right"]}
        forces = {i: 0. for i in touches}
        for index, contact in enumerate(self.data.contact[:self.data.ncon]):
            pair = {int(contact.geom1), int(contact.geom2)}
            if self.cargo_geom not in pair:
                continue
            for finger in touches:
                if finger in pair and contact.dist < .001:
                    force = np.zeros(6)
                    mujoco.mj_contactForce(self.model, self.data, index, force)
                    touches[finger] = True
                    forces[finger] += abs(float(force[0]))
        return list(touches.values()), list(forces.values())

    def cargo_supported(self):
        return any(self.cargo_geom in (c.geom1, c.geom2) and
                   (self.floor in (c.geom1, c.geom2) or self.stand_geom in (c.geom1, c.geom2))
                   and c.dist < .001 for c in self.data.contact[:self.data.ncon])

    def set_job(self, job):
        self.job, self.job_tick = job, self.tick
        self.event(f"Physical Ranger: {job}.")

    def start_job(self):
        if self.job != "idle" or self.failed:
            raise ValueError("Start from a healthy idle Ranger")
        self.job_goal_steps = self.steps+2
        self.mode(True)
        self.set_job("approach")

    def arm_ik(self, side, target):
        scratch = self.scratch
        scratch.qpos[:] = self.data.qpos
        qids, dofs, acts = self.arm_qids[side], self.arm_dofs[side], self.arm_acts[side]
        scratch.qpos[qids] = self.targets[acts]
        limits = self.model.jnt_range[self.arm_joints[side]]
        hand = self.model.body(f"{side}_hand").id
        for _ in range(20):
            mujoco.mj_kinematics(self.model, scratch)
            mujoco.mj_comPos(self.model, scratch)
            rotation = scratch.xmat[hand].reshape(3, 3)
            orientation = sum((np.cross(rotation[:, i], np.eye(3)[:, i]) for i in range(3)), np.zeros(3))*.5
            error = np.r_[target-scratch.site_xpos[self.hand_sites[side]], orientation*.25]
            if np.linalg.norm(error) < .0003:
                break
            mujoco.mj_jacSite(self.model, scratch, self.jp, self.jr, self.hand_sites[side])
            jac = np.vstack([self.jp[:, dofs], .25*self.jr[:, dofs]])
            delta = np.linalg.solve(jac.T@jac+np.eye(len(ARM_PARTS))*1e-4, jac.T@error)
            scratch.qpos[qids] = np.clip(scratch.qpos[qids]+np.clip(delta, -.08, .08), limits[:, 0]+.002, limits[:, 1]-.002)
        return scratch.qpos[qids].copy()

    def control(self):
        elapsed = (self.tick-self.job_tick)*DT
        if self.job in ("approach", "carry") and self.steps == self.job_goal_steps-1 and self.phase == "landing":
            self.walking = False
        if self.job == "approach" and self.phase == "standing" and self.steps >= self.job_goal_steps:
            self.body_origin = self.body_target.copy()
            self.body_center = self.body_target.copy()
            self.body_center[:2] = (self.anchors["left"][:2]+self.anchors["right"][:2])/2-self.com_offset[:2]
            self.set_job("center")
            elapsed = 0
        if self.job == "center":
            self.body_target = self.body_origin+smooth(elapsed/2)*(self.body_center-self.body_origin)
            if elapsed >= 2.5:
                self.hand_origin = self.data.site_xpos[self.hand_sites["right"]].copy()
                self.pickup_target = self.data.xpos[self.cargo].copy()
                self.pickup_target[2] += .045
                self.pregrasp_target = self.pickup_target+np.array([0., 0., .2])
                self.raise_target = self.pickup_target.copy()
                self.raise_target[0] = self.data.qpos[0]+.17
                self.raise_target[2] += .125
                self.set_job("raise")
                elapsed = 0
        if self.job == "raise":
            self.hand_target = self.hand_origin+smooth(elapsed/3)*(self.raise_target-self.hand_origin)
            if elapsed >= 3.5:
                error = np.linalg.norm(self.data.site_xpos[self.hand_sites["right"]]-self.raise_target)
                if error < .035:
                    self.hand_origin = self.hand_target.copy()
                    self.set_job("reach")
                    elapsed = 0
                elif elapsed > 6:
                    self.failed = "Gripper did not clear the pickup stand"
        if self.job == "reach":
            self.hand_target = self.hand_origin+smooth(elapsed/3)*(self.pregrasp_target-self.hand_origin)
            if elapsed >= 3.5:
                error = np.linalg.norm(self.data.site_xpos[self.hand_sites["right"]]-self.pregrasp_target)
                if error < .035:
                    self.hand_origin = self.hand_target.copy()
                    self.set_job("lower")
                    elapsed = 0
                elif elapsed > 6:
                    self.failed = "Gripper did not reach the measured cargo pose"
        if self.job == "lower":
            self.hand_target = self.hand_origin+smooth(elapsed/2)*(self.pickup_target-self.hand_origin)
            if elapsed >= 2.5:
                error = np.linalg.norm(self.data.site_xpos[self.hand_sites["right"]]-self.pickup_target)
                if error < .025:
                    self.grip_closed = True
                    self.set_job("close")
                    elapsed = 0
                elif elapsed > 4:
                    self.failed = "Gripper did not align around the cargo"
        if self.job == "close":
            contacts, forces = self.grip_contacts()
            self.grip_samples = self.grip_samples+1 if all(contacts) and min(forces) > .3 else 0
            if self.grip_samples >= 20:
                self.receipts.append({"event": "finger_contact", "time": self.tick*DT, "forces": forces})
                self.hand_origin = self.hand_target.copy()
                self.set_job("lift")
                elapsed = 0
            elif elapsed > 3:
                self.failed = "Both fingers did not establish measured cargo contact"
        if self.job == "lift":
            self.hand_target = self.hand_origin+np.array([0., 0., .15])*smooth(elapsed/2)
            lift = float(self.data.xpos[self.cargo][2]-self.cargo_start[2])
            contacts, forces = self.grip_contacts()
            valid = lift > .10 and all(contacts) and min(forces) > .3 and not self.cargo_supported()
            self.lift_samples = self.lift_samples+1 if valid else 0
            if elapsed >= 2.5 and self.lift_samples >= 30:
                self.receipts.append({"event": "unsupported_lift", "time": self.tick*DT, "lift": lift, "forces": forces})
                self.carry_offset = self.hand_target-self.data.qpos[:3]
                self.carry_start = self.data.xpos[self.cargo].copy()
                self.job_goal_steps = self.steps+2
                self.mode(True)
                self.set_job("carry")
            elif elapsed > 5:
                self.failed = "Cargo did not remain lifted through finger contact"
        if self.job == "carry":
            self.hand_target = self.data.qpos[:3]+self.carry_offset
            contacts, _ = self.grip_contacts()
            if not all(contacts) or self.cargo_supported():
                self.failed = "Cargo lost contact or returned to support during carry"
            elif self.phase == "standing" and self.steps >= self.job_goal_steps:
                self.receipts.append({"event": "carry", "time": self.tick*DT,
                                      "distance": float(self.data.xpos[self.cargo][0]-self.carry_start[0])})
                self.set_job("holding")
        if self.job == "holding":
            self.hand_target = self.data.qpos[:3]+self.carry_offset
            contacts, forces = self.grip_contacts()
            if not all(contacts) or min(forces) <= .3 or self.cargo_supported():
                self.failed = "Cargo did not remain physically held"
        super().control()
        if self.hand_target is not None:
            angles = self.arm_ik("right", self.hand_target)
            self.targets[self.arm_acts["right"]] = angles
            self.data.ctrl[self.arm_acts["right"]] = angles
        self.data.ctrl[self.finger_acts["right"]] = .075 if self.grip_closed else 0.
        self.max_lift = max(self.max_lift, float(self.data.xpos[self.cargo][2]-self.cargo_start[2]))

    def state(self, geometry=False):
        result = super().state(geometry)
        contacts, forces = self.grip_contacts()
        held = (self.lift_samples >= 30 and all(contacts) and min(forces) > .3
                and not self.cargo_supported() and not self.failed)
        result.update(job=self.job, cargo=self.data.xpos[self.cargo].tolist(), max_lift=self.max_lift,
                      finger_contacts=contacts, finger_normal_forces=forces, cargo_supported=self.cargo_supported(),
                      grasp=self.data.site_xpos[self.hand_sites["right"]].tolist(),
                      arm_angles=self.data.qpos[self.arm_qids["right"]].tolist(),
                      arm_targets=self.targets[self.arm_acts["right"]].tolist(),
                      hand_target=None if self.hand_target is None else self.hand_target.tolist(),
                      manipulation_receipts=[dict(r, object_id="cargo-0", owner_slot=0) for r in self.receipts],
                      actor_binding=None,
                      objects=[{"id": "cargo-0", "position": self.data.xpos[self.cargo].tolist(),
                                "quaternion": self.data.xquat[self.cargo].tolist(), "mass_kg": .12,
                                "held_by": {"slot": 0, "hand": "right"} if held else None,
                                "supported": self.cargo_supported(), "placed": False}])
        return result


def trial(seconds=40):
    if not 0 < seconds <= 90:
        raise ValueError("Use at most 90 simulated seconds")
    sim, started = Ranger(), time.monotonic()
    sim.step(50)
    sim.step(50)
    sim.step(50)
    sim.start_job()
    for _ in range(round(seconds/DT)):
        if time.monotonic()-started > 240:
            raise TimeoutError("Manipulation trial exceeded its wall-clock bound")
        sim.step()
        if sim.failed or (sim.job == "holding" and sim.tick-sim.job_tick >= 100):
            break
    return sim.state()


if __name__ == "__main__":
    seconds = float(sys.argv[sys.argv.index("--trial")+1]) if "--trial" in sys.argv else 40.
    result = trial(seconds)
    print(json.dumps(result))
    if result["failed"] or result["job"] != "holding":
        raise SystemExit(2)
