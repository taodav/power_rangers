"""Load Playground's actual Go1 XML without cloning the entire Menagerie."""

from importlib.metadata import distribution
from pathlib import Path
from urllib.request import urlopen
import xml.etree.ElementTree as ET

import mujoco
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MENAGERIE_REV = "1b86ece576591213e2b666ebf59508454200ca97"
MESHES = ("trunk.stl", "hip.stl", "thigh_mirror.stl", "calf.stl", "thigh.stl")
LEGS = ("FR", "FL", "RR", "RL")
COLORS = {"FR": "#fc6c85", "FL": "#63b3ff", "RR": "#f8cc69", "RL": "#65d6b0"}


def asset_dir() -> Path:
    return ROOT / ".cache" / "go1" / MENAGERIE_REV


def download_assets() -> Path:
    """Explicit setup step; runtime never downloads anything."""
    target = asset_dir()
    target.mkdir(parents=True, exist_ok=True)
    for name in (*MESHES, "LICENSE"):
        file = target / name
        if file.exists():
            continue
        suffix = name if name == "LICENSE" else f"assets/{name}"
        url = f"https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/{MENAGERIE_REV}/unitree_go1/{suffix}"
        print(f"Downloading Go1 {name}…", flush=True)
        with urlopen(url, timeout=60) as response:
            payload = response.read()
        temporary = file.with_suffix(file.suffix + ".tmp")
        temporary.write_bytes(payload)
        temporary.replace(file)
    return target


def load_model() -> mujoco.MjModel:
    directory = Path(distribution("playground").locate_file("mujoco_playground/_src/locomotion/go1/xmls"))
    missing = [name for name in MESHES if not (asset_dir() / name).exists()]
    if missing:
        raise RuntimeError("Go1 meshes missing. Run: uv run rangers setup")
    assets = {p.name: p.read_bytes() for p in directory.glob("*.xml")}
    assets.update({name: (asset_dir() / name).read_bytes() for name in MESHES})
    scene = ET.fromstring((directory / "scene_mjx_feetonly_flat_terrain.xml").read_text())
    # Optional calibration fixture, implemented as an actual physics constraint.
    ET.SubElement(scene.find("worldbody"), "body", name="calibration_anchor", mocap="true", pos="0 0 0.278")
    equality = ET.SubElement(scene, "equality")
    ET.SubElement(equality, "weld", name="calibration_rig", body1="calibration_anchor", body2="trunk", relpose="0 0 0 1 0 0 0", active="false")
    model = mujoco.MjModel.from_xml_string(ET.tostring(scene, encoding="unicode"), assets=assets)
    model.vis.global_.offwidth = 960
    model.vis.global_.offheight = 600
    model.vis.quality.shadowsize = 2048
    # Keep Playground's masses, actuators, solver and contact model. Only recolor.
    for i in range(model.ngeom):
        body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[i])) or ""
        if body_name[:2] in COLORS:
            color = COLORS[body_name[:2]].lstrip("#")
            model.geom_rgba[i] = [*(int(color[j:j+2], 16) / 255 for j in (0, 2, 4)), 1]
            model.geom_matid[i] = -1
    return model


class LegKinematics:
    """Damped least-squares IK, restricted to the selected leg's three joints."""

    def __init__(self, model: mujoco.MjModel):
        self.model = model
        self.scratch = mujoco.MjData(model)
        self.jacobian = np.zeros((3, model.nv))
        self.sites = {leg: model.site(leg).id for leg in LEGS}
        self.joints = {leg: np.array([model.joint(f"{leg}_{part}_joint").id for part in ("hip", "thigh", "calf")]) for leg in LEGS}
        self.qids = {leg: model.jnt_qposadr[ids] for leg, ids in self.joints.items()}
        self.dofs = {leg: model.jnt_dofadr[ids] for leg, ids in self.joints.items()}
        self.actuators = {leg: np.array([model.actuator(f"{leg}_{part}").id for part in ("hip", "thigh", "calf")]) for leg in LEGS}

    def solve(self, data: mujoco.MjData, leg: str, target: np.ndarray, seed: np.ndarray) -> tuple[np.ndarray, float]:
        scratch = self.scratch
        scratch.qpos[:] = data.qpos
        qids = self.qids[leg]
        scratch.qpos[qids] = seed
        limits = self.model.jnt_range[self.joints[leg]]
        for _ in range(20):
            mujoco.mj_kinematics(self.model, scratch)
            mujoco.mj_comPos(self.model, scratch)
            error = target - scratch.site_xpos[self.sites[leg]]
            if np.linalg.norm(error) < 0.0003:
                break
            mujoco.mj_jacSite(self.model, scratch, self.jacobian, None, self.sites[leg])
            jac = self.jacobian[:, self.dofs[leg]]
            delta = jac.T @ np.linalg.solve(jac @ jac.T + 1e-5 * np.eye(3), error)
            scratch.qpos[qids] = np.clip(scratch.qpos[qids] + np.clip(delta, -0.15, 0.15), limits[:, 0] + 0.015, limits[:, 1] - 0.015)
        mujoco.mj_kinematics(self.model, scratch)
        residual = float(np.linalg.norm(target - scratch.site_xpos[self.sites[leg]]))
        return scratch.qpos[qids].copy(), residual
