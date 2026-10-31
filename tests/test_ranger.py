"""Physical one-Ranger bench; invoke through the admitted bounded runner."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("ranger", Path(__file__).resolve().parents[1] / "physics/ranger.py")
physics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(physics)


def run_disabled_grip(*, frictionless=False):
    sim = physics.Ranger()
    if frictionless:
        for geom in [sim.cargo_geom, *sim.fingers["right"]]:
            sim.model.geom_friction[geom] = 0.
    else:
        sim.model.actuator_forcerange[sim.finger_acts["right"]] = 0.
    for _ in range(150):
        sim.step()
    sim.start_job()
    for _ in range(4000):
        sim.step()
        if sim.failed:
            break
    return sim.state()


class RangerTests(unittest.TestCase):
    def test_physical_delivery_releases_and_settles_without_robot_support(self):
        state = physics.trial(55, delivery=True)
        self.assertFalse(state["failed"])
        self.assertEqual(state["job"], "complete")
        self.assertTrue(state["objects"][0]["placed"])
        self.assertIsNone(state["objects"][0]["held_by"])
        receipt = state["manipulation_receipts"][-1]
        self.assertEqual(receipt["event"], "placed")
        self.assertEqual(receipt["evidence"], "measured")
        self.assertEqual(receipt["destination_id"], "station-1")
        self.assertGreaterEqual(receipt["settled_samples"], 50)
        for observed in (receipt, state["placement"]):
            self.assertTrue(observed["valid"])
            self.assertTrue(observed["fingers_open"])
            self.assertFalse(observed["robot_contact"])
            self.assertGreater(observed["support_force"], .5)
            self.assertLess(observed["linear_speed"], .02)
            self.assertLess(observed["tilt_deg"], 8)
            self.assertLess(physics.np.linalg.norm(physics.np.array(observed["position"])-physics.DESTINATION), .025)
        self.assertEqual(state["external_force_max"], 0)

    def test_target_pose_alone_is_not_placement_evidence(self):
        sim = physics.Ranger(delivery=True)
        # Synthetic observation control, not an executor or a claimed physical run.
        sim.data.xpos[sim.cargo] = physics.DESTINATION
        self.assertTrue(sim.placement_observation()["positioned"])
        self.assertFalse(sim.placement_observation()["valid"])
        self.assertFalse(sim.state()["objects"][0]["placed"])

    def test_worker_requires_settling_and_fixed_job_and_refuses_replay(self):
        sim = physics.Ranger(delivery=True)
        command = {"command": "deliver", "jobId": "test-job", "objectId": "cargo-0", "destinationId": "station-1"}
        with self.assertRaises(ValueError):
            physics.worker_command(sim, command)
        for _ in range(3):
            physics.worker_command(sim, {"command": "step", "ticks": 50})
        for invalid in ({**command, "destinationId": "unknown"}, {**command, "jobId": ""},
                        {"command": "reset"}, {"command": "step", "ticks": 100000}):
            with self.assertRaises(ValueError):
                physics.worker_command(sim, invalid)
        state = physics.worker_command(sim, command)
        self.assertEqual(state["job_id"], "test-job")
        self.assertEqual(state["job"], "approach")
        self.assertTrue(state["geoms"])
        with self.assertRaises(ValueError):
            physics.worker_command(sim, command)

    def test_robot_and_cargo_are_free_bodies_without_hidden_support(self):
        sim = physics.Ranger()
        self.assertEqual(sim.model.nmocap, 0)
        self.assertEqual(sim.model.neq, 0)
        self.assertFalse(sim.model.body_gravcomp.any())
        self.assertEqual(sim.model.nu, 28)
        for name in ("root", "cargo_root"):
            joint = sim.model.joint(name).id
            self.assertEqual(sim.model.jnt_type[joint], physics.mujoco.mjtJoint.mjJNT_FREE)
            self.assertNotIn(joint, sim.model.actuator_trnid[:, 0])
        self.assertTrue(sim.model.actuator_forcelimited.all())

    def test_walk_pickup_and_carry_are_measured(self):
        state = physics.trial(40)
        self.assertFalse(state["failed"])
        self.assertEqual(state["job"], "holding")
        self.assertEqual(state["steps"], 4)
        self.assertGreater(state["forward"], .3)
        self.assertLess(state["max_tilt_deg"], 10)
        self.assertGreater(state["max_lift"], .12)
        self.assertFalse(state["cargo_supported"])
        self.assertTrue(all(state["finger_contacts"]))
        self.assertTrue(all(f > .3 for f in state["finger_normal_forces"]))
        self.assertEqual(state["external_force_max"], 0)
        receipts = state["manipulation_receipts"]
        self.assertEqual([r["event"] for r in receipts], ["finger_contact", "unsupported_lift", "carry"])
        self.assertGreater(receipts[-1]["distance"], .15)
        self.assertEqual(state["objects"][0]["held_by"], {"slot": 0, "hand": "right"})
        self.assertFalse(state["objects"][0]["placed"])
        self.assertIsNone(state["actor_binding"])

    def test_no_grip_force_cannot_produce_a_pickup_receipt(self):
        state = run_disabled_grip()
        self.assertTrue(state["failed"])
        self.assertNotIn("unsupported_lift", [r["event"] for r in state["manipulation_receipts"]])
        self.assertIsNone(state["objects"][0]["held_by"])
        self.assertLess(state["max_lift"], .04)

    def test_frictionless_fingers_cannot_carry_the_box(self):
        state = run_disabled_grip(frictionless=True)
        self.assertTrue(state["failed"])
        self.assertNotIn("unsupported_lift", [r["event"] for r in state["manipulation_receipts"]])
        self.assertIsNone(state["objects"][0]["held_by"])
        self.assertLess(state["max_lift"], .04)

    def test_job_start_is_not_replayed(self):
        sim = physics.Ranger()
        sim.start_job()
        with self.assertRaises(ValueError):
            sim.start_job()

    def test_reset_discards_manipulation_state(self):
        sim = physics.Ranger()
        sim.start_job()
        sim.grip_closed = True
        sim.receipts.append({"event": "synthetic_test_receipt"})
        sim.reset()
        self.assertEqual(sim.job, "idle")
        self.assertFalse(sim.grip_closed)
        self.assertEqual(sim.receipts, [])
        self.assertEqual(sim.tick, 0)


if __name__ == "__main__":
    unittest.main()
