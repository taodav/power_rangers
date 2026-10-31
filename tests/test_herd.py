"""Shared-world structural controls and a bounded four-delivery native acceptance."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("herd", Path(__file__).resolve().parents[1]/"physics/herd.py")
physics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(physics)


def jobs():
    return [{"ownerSlot": s, "jobId": f"test-job-{s}", "objectId": f"cargo-{s}", "destinationId": f"station-{s+1}"} for s in range(4)]


class HerdTests(unittest.TestCase):
    def test_one_shared_world_with_disjoint_actuator_ownership(self):
        world = physics.Herd()
        self.assertEqual(world.model.nu, 112)
        self.assertEqual(world.model.nmocap, 0)
        self.assertEqual(world.model.neq, 0)
        self.assertFalse(world.model.body_gravcomp.any())
        self.assertTrue(all(c.model is world.model and c.data is world.data for c in world.controllers))
        self.assertEqual([list(world.owners.values()).count(s) for s in range(4)], [28]*4)
        roots = [world.model.joint(f"r{s}_{name}").id for s in range(4) for name in ("root", "cargo_root")]
        self.assertEqual(len(set(roots)), 8)
        self.assertTrue(all(world.model.jnt_type[j] == physics.mujoco.mjtJoint.mjJNT_FREE for j in roots))
        self.assertTrue(all(j not in world.model.actuator_trnid[:, 0] for j in roots))
        world.step(10)
        self.assertFalse(world.failed)
        self.assertAlmostEqual(world.data.time, .1, places=10)
        self.assertEqual([c.tick for c in world.controllers], [10]*4)
        for controller in world.controllers:
            with self.assertRaises(ValueError):
                controller.step()
            with self.assertRaises(ValueError):
                controller.reset()

    def test_cross_robot_collisions_are_present_not_filtered_away(self):
        # Initial-condition counterfactual only: overlapping robots, no unstable integration.
        world = physics.Herd(origins=((0., 0.), (0., 0.), (5., 0.), (8., 0.)))
        roots = {c.pelvis for c in world.controllers}
        cross = []
        for contact in world.data.contact[:world.data.ncon]:
            a, b = [world.model.body_rootid[world.model.geom_bodyid[g]] for g in (contact.geom1, contact.geom2)]
            if a in roots and b in roots and a != b:
                cross.append(contact)
        self.assertTrue(cross)

    def test_batch_refuses_foreign_cargo_and_replay_without_partial_start(self):
        world = physics.Herd()
        with self.assertRaises(ValueError):
            world.authorize(jobs())
        for _ in range(3):
            world.step(50)
        bad = jobs()
        bad[-1]["objectId"] = "cargo-0"
        with self.assertRaises(ValueError):
            world.authorize(bad)
        self.assertTrue(all(c.job == "idle" for c in world.controllers))
        world.authorize(jobs())
        with self.assertRaises(ValueError):
            world.authorize(jobs())

    def test_foreign_actuator_write_stops_before_integration(self):
        world = physics.Herd()
        controller = world.controllers[0]
        original = controller.control
        foreign = next(a for a, slot in world.owners.items() if slot == 1)
        def wrong_owner():
            original()
            world.data.ctrl[foreign] = .25
        controller.control = wrong_owner
        world.step()
        self.assertIn("another Ranger", world.failed)
        self.assertEqual(world.data.time, 0)

    def test_four_measured_deliveries_share_one_physics_clock(self):
        state = physics.trial(55)
        self.assertFalse(state["failed"], state["failed"])
        self.assertTrue(state["complete"])
        self.assertAlmostEqual(state["time"], state["physics_time"], places=7)
        self.assertEqual(len({obj["id"] for obj in state["objects"]}), 4)
        for slot, controller in enumerate(state["rangers"]):
            self.assertEqual(controller["steps"], 4)
            self.assertLess(controller["max_tilt_deg"], 10)
            self.assertEqual(controller["tick"], state["tick"])
            receipt = controller["manipulation_receipts"][-1]
            self.assertEqual(receipt["event"], "placed")
            self.assertEqual(receipt["owner_slot"], slot)
            self.assertEqual(receipt["object_id"], f"cargo-{slot}")
            self.assertEqual(receipt["destination_id"], f"station-{slot+1}")
            self.assertTrue(receipt["valid"])
            self.assertGreaterEqual(receipt["settled_samples"], 50)
            self.assertIsNone(controller["objects"][0]["held_by"])
            self.assertEqual(controller["external_force_max"], 0)


if __name__ == "__main__":
    unittest.main()
