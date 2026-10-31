"""Native, free-body biped experiment. Only joint actuators move the live model.

The scratch data used for IK may be repositioned. The live data may not: after
reset, only mj_step integrates its free joint. No mocap, weld, gravcomp, or root
wrench supports this robot. This controller is an experiment until validated.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET

import mujoco
import numpy as np

DT = .01
SIDES = ("left", "right")
PARTS = ("hip_yaw", "hip_roll", "hip_pitch", "knee", "ankle_pitch", "ankle_roll")
COLORS = {"left": ".91 .7 .27 1", "right": ".34 .65 .5 1"}
# Only trajectory timing changes between profiles. Contacts, support gates,
# actuator limits, foot placement, clearance and integration rate stay fixed.
GAITS = {
    "cautious": {"shift": 2., "swing": 1.4, "landing": .2},
    "brisk": {"shift": 1.5, "swing": 1.4, "landing": .2},
}


def model_xml() -> str:
    root = ET.Element("mujoco", model="four_ranger_biped")
    ET.SubElement(root, "compiler", angle="radian")
    ET.SubElement(root, "option", timestep="0.002", integrator="implicitfast", gravity="0 0 -9.81", cone="elliptic", iterations="60")
    default = ET.SubElement(root, "default")
    ET.SubElement(default, "joint", damping="1", armature=".02", limited="true")
    ET.SubElement(default, "geom", friction="1 .01 .001", condim="4", solref=".008 1", solimp=".95 .99 .001")
    ET.SubElement(default, "position", kp="2400", kv="100", forcelimited="true", forcerange="-450 450")
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "geom", name="floor", type="plane", size="20 20 .1", rgba=".8 .85 .72 1")
    pelvis = ET.SubElement(world, "body", name="pelvis", pos="0 0 1.025")
    ET.SubElement(pelvis, "freejoint", name="root")
    ET.SubElement(pelvis, "geom", name="pelvis_armor", type="box", size=".19 .31 .1", pos="0 0 .07", mass="7", rgba=".2 .25 .23 1")
    ET.SubElement(pelvis, "geom", name="belt", type="box", size=".21 .33 .045", pos="0 0 .18", mass=".5", rgba=".85 .69 .36 1")
    ET.SubElement(pelvis, "geom", name="chest", type="box", size=".19 .39 .27", pos="0 0 .49", mass="10", rgba=".88 .91 .81 1")
    ET.SubElement(pelvis, "geom", name="chest_visor", type="box", size=".025 .32 .07", pos=".205 0 .61", mass=".1", rgba=".17 .22 .21 1")
    ET.SubElement(pelvis, "geom", name="shoulder_bridge", type="box", size=".12 .68 .075", pos="0 0 .69", mass=".6", rgba=".88 .91 .81 1")
    ET.SubElement(pelvis, "geom", name="crest", type="box", size=".035 .08 .09", pos=".215 0 .44", mass=".1", rgba=".85 .69 .36 1")
    ET.SubElement(pelvis, "geom", name="neck", type="cylinder", size=".07 .06", pos="0 0 .8", mass=".2", rgba=".2 .25 .23 1")
    ET.SubElement(pelvis, "geom", name="helmet", type="box", size=".14 .16 .14", pos="0 0 .94", mass="1", rgba=".9 .92 .85 1")
    ET.SubElement(pelvis, "geom", name="face", type="box", size=".025 .135 .045", pos=".155 0 .965", mass=".1", rgba=".12 .19 .18 1")
    actuator = ET.SubElement(root, "actuator")
    for index, side in enumerate(SIDES):
        sign = -1 if index == 0 else 1
        color = COLORS[side]
        thigh = ET.SubElement(pelvis, "body", name=f"{side}_thigh", pos=f"0 {sign*.255} 0")
        ET.SubElement(thigh, "joint", name=f"{side}_hip_yaw", axis="0 0 1", range="-.6 .6")
        ET.SubElement(thigh, "joint", name=f"{side}_hip_roll", axis="1 0 0", range="-.65 .65")
        ET.SubElement(thigh, "joint", name=f"{side}_hip_pitch", axis="0 1 0", range="-1.1 .7")
        ET.SubElement(thigh, "geom", name=f"{side}_hip_collar", type="sphere", size=".105", mass=".4", rgba=".4 .48 .42 1")
        ET.SubElement(thigh, "geom", name=f"{side}_thigh_armor", type="box", size=".115 .12 .2", pos="0 0 -.23", mass="3", rgba=color)
        calf = ET.SubElement(thigh, "body", name=f"{side}_shin", pos="0 0 -.46")
        ET.SubElement(calf, "joint", name=f"{side}_knee", axis="0 1 0", range=".025 1.8")
        ET.SubElement(calf, "geom", name=f"{side}_knee_shell", type="sphere", size=".105", mass=".3", rgba=".3 .38 .34 1")
        ET.SubElement(calf, "geom", name=f"{side}_shin_armor", type="box", size=".12 .13 .2", pos="0 0 -.23", mass="2", rgba=".9 .92 .85 1")
        ET.SubElement(calf, "geom", name=f"{side}_shin_stripe", type="box", size=".025 .09 .13", pos=".13 0 -.23", mass=".1", rgba=color)
        foot = ET.SubElement(calf, "body", name=f"{side}_foot", pos="0 0 -.46")
        ET.SubElement(foot, "joint", name=f"{side}_ankle_pitch", axis="0 1 0", range="-.85 .65")
        ET.SubElement(foot, "joint", name=f"{side}_ankle_roll", axis="1 0 0", range="-.65 .65")
        ET.SubElement(foot, "geom", name=f"{side}_sole", type="box", size=".22 .17 .06", pos=".06 0 -.06", mass="2", rgba=color)
        ET.SubElement(foot, "site", name=f"{side}_sole_center", pos=".06 0 -.12", size=".01")
        for part in PARTS:
            ET.SubElement(actuator, "position", name=f"{side}_{part}", joint=f"{side}_{part}")
        arm_color = ".91 .32 .24 1" if index == 0 else ".3 .53 .88 1"
        arm = ET.SubElement(pelvis, "body", name=f"{side}_upper_arm", pos=f"0 {sign*.68} .66")
        ET.SubElement(arm, "joint", name=f"{side}_shoulder", axis="0 1 0", range="-.8 .8")
        ET.SubElement(arm, "geom", name=f"{side}_shoulder_collar", type="sphere", size=".12", mass=".4", rgba=".4 .48 .42 1")
        ET.SubElement(arm, "geom", name=f"{side}_upper_arm_armor", type="box", size=".1 .105 .16", pos="0 0 -.17", mass="1", rgba=arm_color)
        forearm = ET.SubElement(arm, "body", name=f"{side}_forearm", pos="0 0 -.34")
        ET.SubElement(forearm, "joint", name=f"{side}_elbow", axis="0 1 0", range="-1.2 .1")
        ET.SubElement(forearm, "geom", name=f"{side}_forearm_armor", type="box", size=".105 .11 .17", pos="0 0 -.17", mass=".8", rgba=arm_color)
        ET.SubElement(forearm, "geom", name=f"{side}_fist", type="box", size=".12 .12 .1", pos=".025 0 -.38", mass=".5", rgba=".3 .38 .34 1")
        for part in ("shoulder", "elbow"):
            ET.SubElement(actuator, "position", name=f"{side}_{part}", joint=f"{side}_{part}", kp="180", kv="12", forcerange="-60 60")
    # Adjacent armor is deliberately close-fitting; exclude only parent chains
    # that form a joint. Ground and non-adjacent self-contact remain physical.
    contact = ET.SubElement(root, "contact")
    for side in SIDES:
        ET.SubElement(contact, "exclude", body1="pelvis", body2=f"{side}_thigh")
        ET.SubElement(contact, "exclude", body1="pelvis", body2=f"{side}_upper_arm")
        ET.SubElement(contact, "exclude", body1="pelvis", body2=f"{side}_forearm")
    return ET.tostring(root, encoding="unicode")


def smooth(t: float) -> float:
    t = min(1., max(0., t))
    return t*t*t*(10+t*(-15+6*t))


class Biped:
    def __init__(self, external_policy=False, gait="cautious", model_source=None, *, model=None, data=None, prefix=""):
        if gait not in GAITS:
            raise ValueError("Choose a supported gait profile")
        self.gait_name, self.gait = gait, GAITS[gait]
        self.external_policy = external_policy
        if (model is None) != (data is None):
            raise ValueError("A shared controller needs both model and data")
        self.shared, self.prefix = model is not None, prefix
        self.model = model if self.shared else mujoco.MjModel.from_xml_string(model_xml() if model_source is None else model_source)
        self.data = data if self.shared else mujoco.MjData(self.model)
        self.reference = mujoco.MjData(self.model)
        self.scratch = mujoco.MjData(self.model)
        self.jp = np.zeros((3, self.model.nv))
        self.jr = np.zeros((3, self.model.nv))
        self.pelvis = self.model.body(self.name("pelvis")).id
        self.floor = self.model.geom("floor").id
        root = self.model.joint(self.name("root")).id
        self.root_q = int(self.model.jnt_qposadr[root])
        self.root_v = int(self.model.jnt_dofadr[root])
        self.origin = self.model.qpos0[self.root_q:self.root_q+3].copy()
        self.joints = {s: np.array([self.model.joint(self.name(f"{s}_{p}")).id for p in PARTS]) for s in SIDES}
        self.qids = {s: self.model.jnt_qposadr[ids] for s, ids in self.joints.items()}
        self.dofs = {s: self.model.jnt_dofadr[ids] for s, ids in self.joints.items()}
        self.acts = {s: np.array([self.model.actuator(self.name(f"{s}_{p}")).id for p in PARTS]) for s in SIDES}
        self.sites = {s: self.model.site(self.name(f"{s}_sole_center")).id for s in SIDES}
        self.soles = {s: self.model.geom(self.name(f"{s}_sole")).id for s in SIDES}
        self._initialize_pose()

    def name(self, local):
        return self.prefix+local

    @property
    def root_position(self):
        return self.data.qpos[self.root_q:self.root_q+3]

    def reset(self):
        if self.shared:
            raise ValueError("Only the shared world may reset its physics")
        self._initialize_pose()

    def _initialize_pose(self):
        if not self.shared:
            mujoco.mj_resetData(self.model, self.data)
        elif self.data.time != 0:
            raise ValueError("Initialize shared controllers only before integration")
        for side in SIDES:
            self.data.qpos[self.qids[side]] = [0, 0, -.45, .9, -.45, 0]
        self.data.qpos[self.root_q+2] = 2*.46*math.cos(.45)+.12
        mujoco.mj_forward(self.model, self.data)
        self.targets = np.array([self.data.qpos[self.model.jnt_qposadr[j]] for j in self.model.actuator_trnid[:, 0]])
        self.anchors = {s: self.foot(s).copy() for s in SIDES}
        for anchor in self.anchors.values():
            anchor[2] = 0.
        self.body_target = self.root_position.copy()
        self.com_offset = self.data.subtree_com[self.pelvis] - self.root_position
        self.phase = "standing"
        self.tick = 0
        self.phase_tick = 0
        self.steps = 0
        self.walking = False
        self.failed = ""
        self.swing = "left"
        self.shift_origin = self.body_target.copy()
        self.shift_target = self.body_target.copy()
        self.swing_origin = self.anchors[self.swing].copy()
        self.swing_target = self.swing_origin.copy()
        self.start = self.root_position.copy()
        self.max_tilt = 0.
        self.max_air = {s: 0. for s in SIDES}
        self.air_ticks = {s: 0 for s in SIDES}
        self.events = []
        self.ready = 0
        self.awaiting = False
        self.arm_targets = {s: [0., -.12] for s in SIDES}
        self.swing_air_ticks = 0
        self.swing_height = 0.
        self.step_evidence = []
        self.phase_ticks = {p: 0 for p in ("standing", "weight_shift", "swing", "landing")}

    def foot(self, side):
        return self.data.site_xpos[self.sites[side]]

    def contacts(self):
        pairs = {frozenset((int(c.geom1), int(c.geom2))) for c in self.data.contact[:self.data.ncon] if c.dist < .001}
        return {s: frozenset((self.floor, geom)) in pairs for s, geom in self.soles.items()}

    def mode(self, walking: bool):
        if type(walking) is not bool:
            raise ValueError("Walking must be a boolean")
        if self.failed:
            raise ValueError("Reset after a failed trial")
        self.walking = walking
        if walking and self.phase == "standing":
            self.request_step()
        elif not walking and self.awaiting:
            self.awaiting = False
            self.phase = "standing"

    def request_step(self):
        if self.external_policy:
            self.awaiting = True
            self.phase = "awaiting_actors"
        else:
            self.begin_shift()

    def authorize(self, plans):
        if not self.external_policy or not self.awaiting:
            raise ValueError("Physics is not awaiting four actor authorizations")
        if not isinstance(plans, list) or len(plans) != 4 or {p.get("slot") for p in plans} != {0, 1, 2, 3}:
            raise ValueError("Exactly four distinct hardware owners are required")
        swing = SIDES[self.steps % 2]
        for plan in plans:
            slot = plan["slot"]
            if slot < 2:
                if plan.get("action") != "balance" or not isinstance(plan.get("shoulder"), (int, float)) or not math.isfinite(plan["shoulder"]) or abs(plan["shoulder"]) > .2:
                    raise ValueError("Invalid owned arm action")
            else:
                action = "step" if SIDES[slot-2] == swing else "support"
                if plan.get("action") != action or plan.get("stride") != .12 or plan.get("clearance") != .09:
                    raise ValueError("Invalid owned leg action")
        # Validate the entire batch before applying any of it.
        for plan in plans:
            if plan["slot"] < 2:
                self.arm_targets[SIDES[plan["slot"]]] = [plan["shoulder"], -.12]
        self.awaiting = False
        self.begin_shift()

    def event(self, text):
        self.events = [*self.events[-39:], {"tick": self.tick, "text": text}]

    def begin_shift(self):
        self.swing = SIDES[self.steps % 2]
        support = SIDES[(self.steps+1) % 2]
        self.shift_origin = self.body_target.copy()
        self.shift_target = self.body_target.copy()
        self.shift_target[:2] = self.anchors[support][:2] - self.com_offset[:2]
        self.shift_target[2] = .91
        self.phase = "weight_shift"
        self.phase_tick = self.tick
        self.ready = 0
        self.event(f"Shift weight to {support}; prepare {self.swing} step.")

    def ik(self, side, target, reference):
        scratch = self.scratch
        scratch.qpos[:] = reference.qpos
        qids, dofs = self.qids[side], self.dofs[side]
        scratch.qpos[qids] = self.targets[self.acts[side]]
        limits = self.model.jnt_range[self.joints[side]]
        foot_body = self.model.body(self.name(f"{side}_foot")).id
        for _ in range(12):
            mujoco.mj_kinematics(self.model, scratch)
            mujoco.mj_comPos(self.model, scratch)
            rotation = scratch.xmat[foot_body].reshape(3, 3)
            orientation = sum((np.cross(rotation[:, i], np.eye(3)[:, i]) for i in range(3)), np.zeros(3))*.5
            error = np.r_[target-scratch.site_xpos[self.sites[side]], orientation*.4]
            if np.linalg.norm(error) < .0002:
                break
            mujoco.mj_jacSite(self.model, scratch, self.jp, self.jr, self.sites[side])
            jac = np.vstack([self.jp[:, dofs], .4*self.jr[:, dofs]])
            delta = np.linalg.solve(jac.T@jac+np.eye(len(PARTS))*1e-5, jac.T@error)
            scratch.qpos[qids] = np.clip(scratch.qpos[qids]+np.clip(delta, -.12, .12), limits[:, 0]+.002, limits[:, 1]-.002)
        return scratch.qpos[qids].copy()

    def control(self):
        elapsed = (self.tick-self.phase_tick)*DT
        feet = {s: v.copy() for s, v in self.anchors.items()}
        if self.phase == "weight_shift":
            self.body_target = self.shift_origin + smooth(elapsed/self.gait["shift"])*(self.shift_target-self.shift_origin)
            support = SIDES[(self.steps+1) % 2]
            com = self.data.subtree_com[self.pelvis]
            stable = (elapsed >= self.gait["shift"] and all(self.contacts().values()) and
                      np.linalg.norm(com[:2]-self.anchors[support][:2]) < .055 and
                      np.linalg.norm(self.data.qvel[self.root_v:self.root_v+2]) < .08)
            self.ready = self.ready+1 if stable else 0
            if self.ready >= 8:
                self.phase, self.phase_tick = "swing", self.tick
                self.swing_origin = self.anchors[self.swing].copy()
                self.swing_target = self.swing_origin.copy()
                self.swing_target[0] = self.anchors[support][0]+.12
                self.swing_target[1] = self.origin[1]+(-.255 if self.swing == "left" else .255)
                self.swing_air_ticks, self.swing_height = 0, 0.
                elapsed = 0
                self.event(f"Lift {self.swing}; other foot supplies support.")
            elif elapsed > 6:
                self.failed = "Weight shift did not meet the contact/COM/velocity gate"
        if self.phase == "swing":
            p = min(1., elapsed/self.gait["swing"])
            feet[self.swing] = self.swing_origin+smooth(p)*(self.swing_target-self.swing_origin)
            feet[self.swing][2] += .09*math.sin(math.pi*p)**2
            if p >= 1:
                self.phase, self.phase_tick = "landing", self.tick
        elif self.phase == "landing":
            feet[self.swing] = self.swing_target.copy()
            feet[self.swing][2] = -.003
            if elapsed > self.gait["landing"] and all(self.contacts().values()) and self.swing_air_ticks >= 5 and self.swing_height > .02 and self.foot(self.swing)[0]-self.swing_origin[0] > .025:
                self.step_evidence.append({"side": self.swing, "time": self.tick*DT,
                                           "forward": float(self.root_position[0]-self.start[0]),
                                           "air_ticks": self.swing_air_ticks, "clearance": self.swing_height,
                                           "travel": float(self.foot(self.swing)[0]-self.swing_origin[0])})
                self.step_evidence = self.step_evidence[-60:]
                self.anchors[self.swing] = self.foot(self.swing).copy()
                self.anchors[self.swing][2] = 0
                self.steps += 1
                self.event(f"Confirmed {self.swing} touchdown; completed step {self.steps}.")
                if self.walking:
                    self.request_step()
                else:
                    self.phase = "standing"
            elif elapsed > 2:
                self.failed = "Swing foot did not confirm ground contact"

        # IK changes only a scratch model. The real free body is never set here.
        self.reference.qpos[:] = self.data.qpos
        self.reference.qpos[self.root_q:self.root_q+3] = self.body_target
        self.reference.qpos[self.root_q+3:self.root_q+7] = [1, 0, 0, 0]
        for side in SIDES:
            angles = self.ik(side, feet[side], self.reference)
            ids = self.acts[side]
            self.targets[ids] = angles
            self.data.ctrl[ids] = angles
        for side in SIDES:
            shoulder = self.model.actuator(self.name(f"{side}_shoulder")).id
            elbow = self.model.actuator(self.name(f"{side}_elbow")).id
            self.data.ctrl[shoulder], self.data.ctrl[elbow] = self.arm_targets[side]

    def step(self, ticks=1):
        if self.shared:
            raise ValueError("Shared physics advances once through its world, not through a controller")
        if type(ticks) is not int or not 1 <= ticks <= 50:
            raise ValueError("Advance 1–50 bounded control ticks")
        for _ in range(ticks):
            if self.failed or self.awaiting:
                return
            self.phase_ticks[self.phase] += 1
            self.control()
            if self.failed:
                return
            for _ in range(5):
                mujoco.mj_step(self.model, self.data)
            mujoco.mj_forward(self.model, self.data)
            self.observe_step()

    def observe_step(self):
        """Read the authoritative post-integration state; never advance physics here."""
        self.tick += 1
        up = self.data.xmat[self.pelvis].reshape(3, 3)[2, 2]
        tilt = math.degrees(math.acos(float(np.clip(up, -1, 1))))
        self.max_tilt = max(self.max_tilt, tilt)
        contacts = self.contacts()
        if self.phase in ("swing", "landing"):
            self.swing_air_ticks += int(not contacts[self.swing])
            self.swing_height = max(self.swing_height, float(self.foot(self.swing)[2]))
        for side in SIDES:
            self.max_air[side] = max(self.max_air[side], float(self.foot(side)[2]))
            self.air_ticks[side] += int(not contacts[side])
        if self.root_position[2] < .65 or tilt > 30 or not np.isfinite(self.data.qpos).all():
            self.failed = "Robot fell or left the finite-state safety envelope"

    def state(self, geometry=False):
        result = {"tick": self.tick, "time": self.tick*DT, "phase": self.phase, "steps": self.steps,
                  "gait": self.gait_name,
                  "gait_timing": dict(self.gait),
                  "phase_seconds": {p: ticks*DT for p, ticks in self.phase_ticks.items()},
                  "walking": self.walking, "failed": self.failed, "body": self.data.qpos[self.root_q:self.root_q+7].tolist(),
                  "awaiting_actors": self.awaiting, "next_swing": SIDES[self.steps % 2],
                  "forward": float(self.root_position[0]-self.start[0]), "lateral": float(self.root_position[1]-self.start[1]),
                  "max_tilt_deg": self.max_tilt, "contacts": self.contacts(), "max_foot_height": self.max_air,
                  "com": self.data.subtree_com[self.pelvis].tolist(), "body_target": self.body_target.tolist(),
                  "feet": {s: self.foot(s).tolist() for s in SIDES},
                  "joint_error": {s: (self.targets[self.acts[s]]-self.data.qpos[self.qids[s]]).tolist() for s in SIDES},
                  "self_contacts": [[self.model.geom(int(c.geom1)).name, self.model.geom(int(c.geom2)).name] for c in self.data.contact[:self.data.ncon] if self.floor not in (c.geom1, c.geom2)],
                  "air_ticks": self.air_ticks, "events": self.events,
                  "step_evidence": self.step_evidence,
                  "external_force_max": float(max(np.abs(self.data.xfrc_applied).max(), np.abs(self.data.qfrc_applied).max())),
                  "mocap_bodies": self.model.nmocap, "equality_constraints": self.model.neq}
        if geometry:
            result["geoms"] = [{"name": mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_GEOM, i),
                                "type": int(self.model.geom_type[i]), "size": self.model.geom_size[i].tolist(),
                                "rgba": self.model.geom_rgba[i].tolist(), "pos": self.data.geom_xpos[i].tolist(),
                                "mat": self.data.geom_xmat[i].tolist()} for i in range(1, self.model.ngeom)]
        return result


def trial(seconds=20., walk=True, gait="cautious", seed=0):
    if not 0 < seconds <= 90:
        raise ValueError("Trial duration must be within 90 simulated seconds")
    sim = Biped(gait=gait)
    if type(seed) is not int or not 0 <= seed <= 10000:
        raise ValueError("Use a bounded initial-condition seed")
    initial_velocity = np.random.default_rng(seed).uniform(-.02, .02, 2) if seed else np.zeros(2)
    # Test initial conditions, set once before any simulation integration.
    sim.data.qvel[:2] = initial_velocity
    start = time.monotonic()
    for _ in range(150):
        sim.step()
    walk_start_x, walk_start_tick = float(sim.data.qpos[0]), sim.tick
    if walk and not sim.failed:
        sim.mode(True)
    for _ in range(round(seconds/DT)):
        if time.monotonic()-start > 240:
            raise TimeoutError("Native trial exceeded its 240-second inner wall-clock bound")
        sim.step()
        if sim.failed:
            break
    result = sim.state()
    result["seed"], result["initial_velocity"] = seed, initial_velocity.tolist()
    elapsed = (sim.tick-walk_start_tick)*DT
    result["walking_seconds"] = elapsed
    result["walking_distance"] = float(sim.data.qpos[0])-walk_start_x
    result["average_speed_m_s"] = result["walking_distance"]/elapsed if elapsed else 0.
    samples = sim.step_evidence[2:]
    result["steady_speed_m_s"] = (float(np.polyfit([p["time"] for p in samples],
                                                 [p["forward"] for p in samples], 1)[0])
                                   if len(samples) >= 3 else None)
    return result


if __name__ == "__main__":
    if "--compare-gaits" in sys.argv:
        seconds = float(sys.argv[sys.argv.index("--compare-gaits")+1])
        started, results = time.monotonic(), []
        for seed in range(3):
            for gait in GAITS:
                if time.monotonic()-started > 240:
                    raise TimeoutError("Comparison exceeded its inner wall-clock bound")
                result = trial(seconds, True, gait, seed)
                print(json.dumps(result), flush=True)
                results.append(result)
        if any(r["failed"] for r in results):
            raise SystemExit(2)
    elif "--trial" in sys.argv:
        gait = sys.argv[sys.argv.index("--gait")+1] if "--gait" in sys.argv else "cautious"
        result = trial(float(sys.argv[sys.argv.index("--trial")+1]), "--stand" not in sys.argv, gait)
        print(json.dumps(result))
        if result["failed"]:
            raise SystemExit(2)
    else:
        # No process spawning, network, environment reads, or filesystem writes.
        sim = Biped(external_policy=True, gait="brisk")
        for line in sys.stdin:
            try:
                if len(line) > 2048:
                    raise ValueError("Small worker command required")
                request = json.loads(line)
                if request["command"] == "step":
                    sim.step(request.get("ticks", 1))
                elif request["command"] == "mode":
                    sim.mode(request["walking"])
                elif request["command"] == "reset":
                    sim.reset()
                elif request["command"] == "authorize":
                    sim.authorize(request["plans"])
                elif request["command"] != "state":
                    raise ValueError("Unknown physics command")
                print(json.dumps({"ok": True, "state": sim.state(geometry=True)}), flush=True)
            except Exception as error:
                print(json.dumps({"ok": False, "error": str(error)}), flush=True)
