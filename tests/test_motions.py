import json

import numpy as np
import pytest

from power_rangers.motions import Motion
from power_rangers.simulation import Simulation


@pytest.mark.parametrize("leg", ["FR", "FL", "RR", "RL"])
def test_each_leg_lifts_and_lands_in_calibration_rig(leg):
    sim = Simulation()
    action = sim.start(leg)
    sim.step(100)
    assert action.status == "completed", action.reason
    assert action.saw_air
    assert action.max_clearance > 0.02
    assert sim.contacts()[leg]
    assert not sim.fallen
    assert abs(sim.data.time - 2.0) < 1e-9


def test_stand_without_rig():
    sim = Simulation(rig=False)
    sim.step(250)
    assert not sim.fallen
    assert all(sim.contacts().values())
    assert 0.24 < sim.data.qpos[2] < 0.29


def test_motions_finish_independently():
    sim = Simulation()
    short = sim.start("FR", duration=0.4)
    long = sim.start("FL", duration=1.0)
    while short.status == "running":
        sim.step()
        assert sim.tick < 50
    assert long.status == "running"
    assert "FR" not in sim.active and "FL" in sim.active
    sim.step(60)
    assert long.status == "completed"
    assert short.end_tick < long.end_tick


def test_json_checkpoint_resumes_mid_swing():
    original = Simulation()
    original.start("FL")
    original.start("RR", duration=0.9)
    original.step(11)
    saved = json.loads(json.dumps(original.checkpoint()))
    restored = Simulation()
    restored.restore(saved)
    assert restored.tick == original.tick
    assert restored.state()["legs"]["FL"]["active"] == original.state()["legs"]["FL"]["active"]
    original.step(60)
    restored.step(60)
    np.testing.assert_allclose(restored.data.qpos, original.data.qpos, atol=1e-8)
    assert [m.to_dict() for m in restored.history] == [m.to_dict() for m in original.history]


def test_initial_contact_is_not_a_touchdown_and_missing_contact_times_out():
    action = Motion("FL-1", "FL", "swing_to", 0, 20, 25, [0, 0, .02], [.04, 0, .02])
    for tick in range(1, 10):
        action.observe(tick, True, .02)
    assert action.status == "running"
    for tick in range(10, 26):
        action.observe(tick, False, .05)
    assert action.status == "failed"
    assert action.reason == "no touchdown"
    assert action.end_tick == 25


def test_reading_state_does_not_advance_time_and_busy_leg_is_rejected():
    sim = Simulation()
    sim.start("FL")
    with pytest.raises(ValueError, match="active motion"):
        sim.start("FL")
    for _ in range(10):
        assert sim.state()["tick"] == 0


@pytest.mark.parametrize("kwargs", [{"duration": float("nan")}, {"clearance": .5}, {"forward": -.5}])
def test_invalid_parameters_are_rejected(kwargs):
    sim = Simulation()
    with pytest.raises(ValueError):
        sim.start("FL", **kwargs)
