import json

import numpy as np
import pytest

from power_rangers.policy import LocalPolicies, configure, validate_goal
from power_rangers.simulation import Simulation


@pytest.fixture(scope='module')
def policies():
    worker = LocalPolicies()
    yield worker
    worker.close()


def advance(sim, policies, calls):
    for _ in range(calls):
        if sim.crawl.state.phase == 'awaiting_decision':
            policies.decide(sim)
        sim.step()
        if sim.crawl.state.status != 'running':
            break


def make(goal, cycles=3):
    sim = Simulation(rig=False)
    sim.start_crawl(cycles, external_policy=True)
    configure(sim, goal=goal)
    return sim


@pytest.mark.parametrize('goal,metric,direction,minimum', [
    ({'vx':.012,'vy':0.,'yaw_rate':0.}, 'forward_m', 1, .15),
    ({'vx':-.012,'vy':0.,'yaw_rate':0.}, 'forward_m', -1, .10),
    ({'vx':0.,'vy':.008,'yaw_rate':0.}, 'lateral_m', 1, .08),
    ({'vx':0.,'vy':-.008,'yaw_rate':0.}, 'lateral_m', -1, .08),
    ({'vx':0.,'vy':0.,'yaw_rate':.04}, 'yaw_deg', 1, 25),
    ({'vx':0.,'vy':0.,'yaw_rate':-.04}, 'yaw_deg', -1, 25),
])
def test_goal_drives_actual_body_motion(policies, goal, metric, direction, minimum):
    sim = make(goal)
    advance(sim, policies, 3500)
    result = sim.crawl.telemetry(sim)
    assert result['status'] == 'completed', result['reason']
    assert result[metric] * direction > minimum
    assert result['max_tilt_deg'] < 5
    assert len(sim.history) == 12 and all(m.status == 'completed' for m in sim.history)
    assert all(sim.contacts().values()) and not sim.fallen
    assert not sim.data.eq_active.any() and not sim.data.xfrc_applied.any() and not sim.data.qfrc_applied.any()


def test_zero_goal_advances_time_without_steps_and_can_resume(policies):
    sim = make({'vx':0.,'vy':0.,'yaw_rate':0.})
    advance(sim, policies, 150)
    assert sim.tick >= 140
    assert not sim.active and not sim.history and not sim.fallen
    assert all(sim.contacts().values())
    sim.crawl.state.goal = {'vx':-.012,'vy':0.,'yaw_rate':0.}
    advance(sim, policies, 3000)
    assert sim.crawl.state.status == 'completed'
    assert sim.crawl.telemetry(sim)['forward_m'] < -.10


def test_new_goal_preserves_inflight_target_and_checkpoint(policies):
    sim = make({'vx':.012,'vy':0.,'yaw_rate':0.})
    while not sim.active:
        advance(sim, policies, 1)
    sim.step(5)
    action = next(iter(sim.active.values()))
    original_target = list(action.target)
    sim.crawl.state.goal = {'vx':0.,'vy':0.,'yaw_rate':.04}
    saved = json.loads(json.dumps(sim.checkpoint()))
    restored = Simulation()
    restored.restore(saved)
    assert next(iter(restored.active.values())).target == original_target
    advance(sim, policies, 3000)
    advance(restored, policies, 3000)
    np.testing.assert_array_equal(sim.data.qpos, restored.data.qpos)
    assert sim.crawl.telemetry(sim)['yaw_deg'] > 20
    assert sim.crawl.state.status == 'completed'


def test_timed_wait_for_contact_recovery_does_not_spin_without_physics(policies):
    sim = make({'vx':.012,'vy':0.,'yaw_rate':0.})
    sim.crawl.reserve_hold(sim)
    sim.step(5)
    assert sim.tick == 5 and sim.crawl.state.phase == 'goal_hold'
    assert not sim.active


@pytest.mark.parametrize('goal', [None, {}, {'vx':float('nan'),'vy':0.,'yaw_rate':0.},
                                  {'vx':.03,'vy':0.,'yaw_rate':0.}, {'vx':0.,'vy':0.,'yaw_rate':.1}])
def test_goal_validation(goal):
    with pytest.raises(ValueError):
        validate_goal(goal)
