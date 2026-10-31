"""Offscreen rendering stays on the main thread for macOS OpenGL."""

import io

import mujoco
import numpy as np
from PIL import Image


class View:
    def __init__(self, simulation):
        self.simulation = simulation
        self.renderer = mujoco.Renderer(simulation.model, height=600, width=960)
        self.camera = mujoco.MjvCamera()
        self.camera.lookat[:] = [0, 0, 0.16]
        self.camera.distance = 1.25
        self.camera.azimuth = 135
        self.camera.elevation = -25
        self.options = mujoco.MjvOption()
        self.options.geomgroup[3] = 0
        self.options.sitegroup[5] = 0

    def frame(self) -> Image.Image:
        sim = self.simulation
        self.camera.lookat[:2] = sim.data.qpos[:2]
        self.renderer.update_scene(sim.data, camera=self.camera, scene_option=self.options)
        # Show the calibration fixture explicitly, rather than hiding assistance.
        if sim.rig:
            scene = self.renderer.scene
            index = scene.ngeom
            if index < scene.maxgeom:
                start = sim.data.xpos[sim.trunk].copy()
                end = start + np.array([0, 0, 0.55])
                mujoco.mjv_initGeom(scene.geoms[index], mujoco.mjtGeom.mjGEOM_CAPSULE,
                                   np.zeros(3), np.zeros(3), np.eye(3).ravel(), np.array([0.45, 0.5, 0.6, 0.7], dtype=np.float32))
                mujoco.mjv_connector(scene.geoms[index], mujoco.mjtGeom.mjGEOM_CAPSULE, 0.004, start, end)
                scene.ngeom += 1
        if sim.crawl is not None:
            state = sim.state()
            vertices = state["support_polygon"]
            for i in range(len(vertices)):
                start = np.r_[vertices[i], 0.006]
                end = np.r_[vertices[(i + 1) % len(vertices)], 0.006]
                self._line(start, end, [0.15, 0.7, 0.55, 1], 0.003)
            com = np.array(state["com"])
            self._line(np.r_[com[:2], 0.01], com, [1, 0.55, 0.1, 0.8], 0.002)
            scene = self.renderer.scene
            if scene.ngeom < scene.maxgeom:
                mujoco.mjv_initGeom(scene.geoms[scene.ngeom], mujoco.mjtGeom.mjGEOM_SPHERE,
                                   np.array([0.012, 0, 0]), np.r_[com[:2], 0.012], np.eye(3).ravel(),
                                   np.array([1, 0.55, 0.1, 1], dtype=np.float32))
                scene.ngeom += 1
        return Image.fromarray(self.renderer.render())

    def _line(self, start, end, color, radius):
        scene = self.renderer.scene
        if scene.ngeom < scene.maxgeom:
            mujoco.mjv_initGeom(scene.geoms[scene.ngeom], mujoco.mjtGeom.mjGEOM_CAPSULE,
                               np.zeros(3), np.zeros(3), np.eye(3).ravel(), np.array(color, dtype=np.float32))
            mujoco.mjv_connector(scene.geoms[scene.ngeom], mujoco.mjtGeom.mjGEOM_CAPSULE, radius, start, end)
            scene.ngeom += 1

    def jpeg(self) -> bytes:
        output = io.BytesIO()
        self.frame().save(output, format="JPEG", quality=85)
        return output.getvalue()

    def close(self):
        self.renderer.close()
