"""Bounded native checks; run through physics/run_bounded.py --test."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

SPEC = importlib.util.spec_from_file_location("megazord", Path(__file__).resolve().parents[1] / "physics/megazord.py")
physics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(physics)


def batch(swing="left"):
    direction = 1 if swing == "left" else -1
    return [{"slot": 0, "action": "balance", "shoulder": -.08*direction},
            {"slot": 1, "action": "balance", "shoulder": .08*direction},
            {"slot": 2, "action": "step" if swing == "left" else "support", "stride": .12, "clearance": .09},
            {"slot": 3, "action": "support" if swing == "left" else "step", "stride": .12, "clearance": .09}]


class NativeTests(unittest.TestCase):
    def test_worker_starts_brisk_and_keeps_the_four_actor_barrier(self):
        root = Path(__file__).resolve().parents[1]
        environment = {"HOME": str(root / ".cache/world/home"), "TMPDIR": str(root / ".cache/world/tmp"),
                       "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "OMP_NUM_THREADS": "1",
                       "OPENBLAS_NUM_THREADS": "1", "VECLIB_MAXIMUM_THREADS": "1"}
        result = subprocess.run([sys.executable, "-I", "-B", str(root / "physics/megazord.py")],
                                input='{"command":"mode","walking":true}\n{"command":"step","ticks":5}\n',
                                text=True, capture_output=True, check=True, timeout=10, env=environment, cwd=root)
        states = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(states), 2)
        for response in states:
            self.assertTrue(response["ok"])
            self.assertEqual(response["state"]["gait"], "brisk")
            self.assertTrue(response["state"]["awaiting_actors"])
            self.assertEqual(response["state"]["tick"], 0)

    def test_no_hidden_root_support(self):
        sim = physics.Biped()
        self.assertEqual(sim.model.nmocap, 0)
        self.assertEqual(sim.model.neq, 0)
        self.assertFalse(sim.model.body_gravcomp.any())
        self.assertEqual(sim.model.nu, 16)
        root = sim.model.joint("root").id
        self.assertNotIn(root, sim.model.actuator_trnid[:, 0])

    def test_free_body_stands_on_both_feet(self):
        sim = physics.Biped()
        for _ in range(500):
            sim.step()
        state = sim.state()
        self.assertFalse(state["failed"])
        self.assertTrue(all(state["contacts"].values()))
        self.assertLess(state["max_tilt_deg"], 8)
        self.assertEqual(state["external_force_max"], 0)
        self.assertEqual(state["self_contacts"], [])

    def test_joint_driven_alternating_walk(self):
        state = physics.trial(20, True)
        self.assertFalse(state["failed"])
        self.assertGreaterEqual(state["steps"], 4)
        self.assertGreater(state["forward"], .3)
        self.assertLess(state["max_tilt_deg"], 10)
        self.assertTrue(all(value > .02 for value in state["max_foot_height"].values()))
        self.assertTrue(all(value > 50 for value in state["air_ticks"].values()))
        self.assertEqual(len(state["step_evidence"]), state["steps"])
        self.assertTrue(all(step["clearance"] > .02 and step["air_ticks"] >= 5 and step["travel"] > .025 for step in state["step_evidence"]))
        self.assertEqual(state["external_force_max"], 0)

    def test_brisk_profile_increases_physical_not_playback_speed(self):
        cautious, brisk = (physics.trial(20, True, gait) for gait in ("cautious", "brisk"))
        self.assertFalse(brisk["failed"])
        self.assertEqual(brisk["walking_seconds"], cautious["walking_seconds"])
        self.assertGreater(brisk["steady_speed_m_s"], cautious["steady_speed_m_s"]*1.1)
        self.assertGreater(brisk["steps"], cautious["steps"])
        self.assertLess(brisk["max_tilt_deg"], 10)
        self.assertEqual(len(brisk["step_evidence"]), brisk["steps"])
        self.assertTrue(all(s["clearance"] > .02 and s["air_ticks"] >= 5 and s["travel"] > .025 for s in brisk["step_evidence"]))
        self.assertEqual(brisk["external_force_max"], 0)

    def test_profiles_keep_the_same_mechanics(self):
        cautious, brisk = (physics.Biped(gait=g) for g in ("cautious", "brisk"))
        for field in ("actuator_forcerange", "jnt_range", "body_mass", "geom_friction"):
            physics.np.testing.assert_array_equal(getattr(cautious.model, field), getattr(brisk.model, field))
        self.assertEqual(cautious.model.opt.timestep, brisk.model.opt.timestep)
        with self.assertRaises(ValueError):
            physics.Biped(gait="unvalidated")

    def test_brisk_walk_executes_six_separate_owned_batches(self):
        sim = physics.Biped(external_policy=True, gait="brisk")
        for _ in range(150):
            sim.step()
        sim.mode(True)
        authorized = 0
        for _ in range(2500):
            if sim.awaiting:
                if sim.steps == 6:
                    break
                self.assertLess(sim.max_tilt, 12)
                self.assertTrue(all(sim.contacts().values()))
                sim.authorize(batch(physics.SIDES[sim.steps % 2]))
                authorized += 1
            sim.step()
            self.assertFalse(sim.failed)
        self.assertEqual(sim.steps, 6)
        self.assertEqual(authorized, 6)
        self.assertTrue(sim.awaiting)
        self.assertGreater(sim.state()["forward"], .5)
        self.assertEqual(sim.state()["external_force_max"], 0)
        self.assertEqual([s["side"] for s in sim.step_evidence], ["left", "right"]*3)

    def test_missing_actor_batch_freezes_the_physics_clock(self):
        sim = physics.Biped(external_policy=True, gait="brisk")
        sim.step(50)
        sim.mode(True)
        tick = sim.tick
        sim.step(50)
        self.assertEqual(sim.tick, tick)
        with self.assertRaises(ValueError):
            sim.authorize(batch()[:3])
        wrong = batch()
        wrong[3]["action"] = "step"
        with self.assertRaises(ValueError):
            sim.authorize(wrong)
        self.assertTrue(sim.awaiting)
        sim.authorize(batch())
        sim.step()
        self.assertEqual(sim.tick, tick+1)

    def test_each_new_step_requires_a_fresh_four_owner_batch(self):
        sim = physics.Biped(external_policy=True, gait="brisk")
        for _ in range(150):
            sim.step()
        sim.mode(True)
        sim.authorize(batch())
        for _ in range(500):
            sim.step()
            if sim.awaiting:
                break
        self.assertEqual(sim.steps, 1)
        self.assertTrue(sim.awaiting)
        self.assertEqual(sim.phase, "awaiting_actors")
        with self.assertRaises(ValueError):
            sim.authorize(batch("left"))
        sim.authorize(batch("right"))
        self.assertFalse(sim.awaiting)

    def test_finish_and_hold_does_not_reset_pose(self):
        sim = physics.Biped(gait="brisk")
        for _ in range(150):
            sim.step()
        sim.mode(True)
        for _ in range(250):
            sim.step()
        before = sim.tick
        sim.mode(False)
        for _ in range(300):
            sim.step()
        self.assertGreater(sim.tick, before)
        self.assertEqual(sim.phase, "standing")
        self.assertEqual(sim.steps, 1)
        self.assertFalse(sim.failed)

    def test_tick_bounds_refuse_without_changing_state(self):
        sim = physics.Biped()
        for ticks in (0, -1, 51, True, 1.5):
            with self.assertRaises(ValueError):
                sim.step(ticks)
        self.assertEqual(sim.tick, 0)


if __name__ == "__main__":
    unittest.main()
