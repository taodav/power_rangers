import json

import numpy as np
import pytest

from power_rangers.crawl import ORDER, support_margin
from power_rangers.model import LEGS
from power_rangers.simulation import Simulation


def finish(sim, limit=3500):
    for _ in range(limit):
        sim.step()
        if sim.crawl.state.status != "running":
            return
    pytest.fail("Crawl did not terminate within its time budget")


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_three_cycles_with_small_initial_velocity_perturbations(seed):
    sim = Simulation(rig=False)
    sim.data.qvel[:6] = np.random.default_rng(seed).normal(0, .015, 6)
    sim.start_crawl(3)
    finish(sim)
    report = sim.crawl.telemetry(sim)
    assert report["status"] == "completed", report["reason"]
    assert report["completed_steps"] == 12
    assert report["forward_m"] > 0.15
    assert report["max_tilt_deg"] < 5
    assert report["min_height"] > .24
    assert all(m.status == "completed" and m.saw_air for m in sim.history)
    assert [m.leg for m in sim.history] == list(ORDER) * 3
    assert all(sim.contacts().values())
    assert not sim.fallen
    assert not sim.data.eq_active.any()
    assert not sim.data.xfrc_applied.any()
    assert not sim.data.qfrc_applied.any()


def test_swing_waits_for_weight_shift_inside_remaining_support_triangle():
    sim = Simulation(rig=False)
    sim.start_crawl(1)
    sim.step(30)
    assert sim.crawl.state.phase == "weight_shift"
    assert not sim.active
    while not sim.active:
        sim.step()
        assert sim.tick < 180
    leg = next(iter(sim.active))
    remaining_feet = np.array([sim.foot(l) for l in LEGS if l != leg])
    assert support_margin(sim.data.subtree_com[sim.trunk], remaining_feet) > .015


@pytest.mark.parametrize("tick", [25, 85])
def test_stop_finishes_current_placement_and_recenters(tick):
    sim = Simulation(rig=False)
    sim.start_crawl(3)
    sim.step(tick)
    sim.crawl.request_stop()
    finish(sim, limit=300)
    assert sim.crawl.state.status == "stopped"
    assert sim.crawl.state.phase == "holding"
    assert not sim.active
    assert all(sim.contacts().values())
    assert not sim.fallen
    assert all(m.status == "completed" for m in sim.history)


def test_checkpoint_continues_crawl_and_balance_controller():
    sim = Simulation(rig=False)
    sim.start_crawl(2)
    sim.step(85)
    saved = json.loads(json.dumps(sim.checkpoint()))
    restored = Simulation()
    restored.restore(saved)
    finish(sim)
    finish(restored)
    np.testing.assert_array_equal(sim.data.qpos, restored.data.qpos)
    assert sim.crawl.snapshot() == restored.crawl.snapshot()
    assert sim.crawl.state.status == "completed"


def test_failed_swing_stops_sequence_instead_of_starting_next_leg():
    sim = Simulation(rig=False)
    sim.start_crawl(2)
    sim.step(85)
    action = next(iter(sim.active.values()))
    action.deadline_tick = sim.tick + 1
    sim.step(2)
    assert sim.crawl.state.status == "failed"
    assert sim.crawl.state.completed_steps == 0
    assert not sim.active
    tick = sim.tick
    sim.step(100)
    assert sim.tick == tick


def test_crawl_rejects_fixture_and_manual_commands():
    sim = Simulation()
    with pytest.raises(ValueError, match="rig"):
        sim.start_crawl()
    sim.rig = False
    sim.reset()
    sim.start_crawl()
    with pytest.raises(ValueError, match="manual"):
        sim.start("FL")


def test_support_margin_is_signed_and_requires_three_points():
    triangle = np.array([[0, 0], [1, 0], [0, 1]])
    assert support_margin(np.array([.2, .2]), triangle) > 0
    assert support_margin(np.array([1, 1]), triangle) < 0
    assert support_margin(np.array([.2, .2]), triangle[:2]) < 0
