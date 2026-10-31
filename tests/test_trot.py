"""Physical concurrency, paired landing barriers, and exact continuation."""
import json

import numpy as np
import pytest

from power_rangers.evaluation import PAIRED_SCENARIOS, rollout
from power_rangers.policy import LocalPolicies, configure
from power_rangers.simulation import Simulation
from power_rangers.trot import PAIRS, TrotController


@pytest.fixture(scope='module')
def policies():
    worker = LocalPolicies()
    yield worker
    worker.close()


def make(cycles=3):
    sim = Simulation(rig=False)
    sim.start_crawl(cycles, external_policy=True)
    configure(sim, 'trot', 'brisk')
    return sim


def advance(sim, policies, calls):
    for _ in range(calls):
        if sim.crawl.state.phase == 'awaiting_decision':
            policies.decide(sim)
        sim.step()
        if sim.crawl.state.status != 'running':
            break


def airborne_pair(sim, policies):
    for _ in range(200):
        advance(sim, policies, 1)
        if len(sim.active) == 2 and all(not sim.contacts()[l] for l in sim.active):
            return
    pytest.fail('No concurrent airborne diagonal pair')


def test_actual_pairs_share_start_ticks_and_alternate_after_both_land(policies):
    sim = make(6)
    overlaps = []
    for _ in range(1200):
        advance(sim, policies, 1)
        airborne = {l for l,m in sim.active.items() if not sim.contacts()[l]}
        if len(airborne) == 2:
            assert airborne in [set(p) for p in PAIRS]
            assert all(c for l,c in sim.contacts().items() if l not in airborne)
            overlaps.append(sim.tick)
        if sim.crawl.state.status != 'running': break
    assert sim.crawl.state.status == 'completed', sim.crawl.state.reason
    assert len(overlaps) > 80
    starts = sorted({m.start_tick for m in sim.history})
    assert len(starts) == 12
    previous_end = -1
    for index,tick in enumerate(starts):
        pair = [m for m in sim.history if m.start_tick == tick]
        assert {m.leg for m in pair} == set(PAIRS[index%2])
        assert all(m.status == 'completed' and m.saw_air for m in pair)
        assert tick > previous_end
        previous_end = max(m.end_tick for m in pair)
    assert sim.crawl.state.max_concurrent_swings == 2
    assert sim.crawl.telemetry(sim)['forward_m'] > .40
    assert not sim.fallen and all(sim.contacts().values())
    assert not sim.data.eq_active.any() and not sim.data.xfrc_applied.any() and not sim.data.qfrc_applied.any()


@pytest.mark.parametrize('scenario,metric,sign,minimum', [
    ('forward_fast','forward_m',1,.38), ('reverse_fast','forward_m',-1,.32),
    ('side_left_fast','lateral_m',1,.15), ('side_right_fast','lateral_m',-1,.15),
    ('left_turn_fast','yaw_deg',1,40), ('right_turn_fast','yaw_deg',-1,40),
    ('curve_fast','yaw_deg',1,30),
])
def test_paired_goals_move_actual_body(policies, scenario, metric, sign, minimum):
    report = rollout(policies, 'trot', 'brisk', PAIRED_SCENARIOS[scenario], seed=3, cycles=6)
    assert report['status'] == 'completed', report['reason']
    assert report[metric]*sign > minimum
    assert report['max_concurrent_swings'] == 2 and report['concurrent_air_s'] > 2
    assert report['max_tilt_deg'] < 8 and not report['fallen']
    if scenario == 'forward_fast':
        assert report['steady_velocity_world_m_s'][0] > .04


def test_midair_pair_checkpoint_and_goal_change_preserve_both_targets(policies):
    sim = make()
    airborne_pair(sim, policies)
    targets = {l:list(m.target) for l,m in sim.active.items()}
    sim.crawl.state.goal = {'vx':0.,'vy':0.,'yaw_rate':.12}
    saved = json.loads(json.dumps(sim.checkpoint()))
    restored = Simulation()
    restored.restore(saved)
    assert isinstance(restored.crawl, TrotController)
    assert {l:m.target for l,m in restored.active.items()} == targets
    revision = policies.revision
    advance(sim, policies, 1000)
    policies.revision = revision  # Replay the same decision IDs as well as physics.
    advance(restored, policies, 1000)
    np.testing.assert_array_equal(sim.data.qpos, restored.data.qpos)
    assert sim.crawl.snapshot() == restored.crawl.snapshot()
    assert sim.crawl.state.status == 'completed'
    assert sim.crawl.telemetry(sim)['yaw_deg'] > 15


@pytest.mark.parametrize('stop', [True, False])
def test_stop_or_hold_waits_for_both_landings(policies, stop):
    sim = make()
    airborne_pair(sim, policies)
    ids = {m.action_id for m in sim.active.values()}
    if stop:
        sim.crawl.request_stop()
    else:
        sim.crawl.state.goal = {'vx':0.,'vy':0.,'yaw_rate':0.}
    advance(sim, policies, 180)
    assert not sim.active and all(sim.contacts().values()) and not sim.fallen
    assert len(sim.history) == 2
    assert {m.action_id for m in sim.history} == ids
    assert all(m.status == 'completed' for m in sim.history)
    assert sim.crawl.state.status == ('stopped' if stop else 'running')
    if not stop:
        tick = sim.tick
        advance(sim, policies, 30)
        assert sim.tick >= tick+28
        reverse_start = sim.data.qpos[0]
        sim.crawl.state.goal = {'vx':-.05,'vy':0.,'yaw_rate':0.}
        advance(sim, policies, 1000)
        assert sim.crawl.state.status == 'completed'
        assert sim.data.qpos[0] - reverse_start < -.10


def test_failed_partner_aborts_entire_pair(policies):
    sim = make()
    airborne_pair(sim, policies)
    sim.active['FR'].deadline_tick = sim.tick+1
    sim.step()
    assert sim.crawl.state.status == 'failed'
    assert sim.crawl.state.completed_steps == 0 and not sim.active
    tick = sim.tick
    sim.step(100)
    assert sim.tick == tick
    assert len(sim.history) == 2 and all(m.status == 'failed' for m in sim.history)


@pytest.mark.parametrize('legs', [('FR',), ('FR','FL'), ('FL','RR'), ('FR','FR')])
def test_incomplete_or_wrong_pair_is_rejected_without_mutation(legs):
    sim = make()
    saved = sim.checkpoint()
    intents = [dict(leg=l,id=l,target=(sim.foot(l)+[.04,0,0]).tolist(),duration=.24,clearance=.025) for l in legs]
    with pytest.raises(ValueError, match='complete next diagonal'):
        sim.crawl.reserve_batch(sim, intents)
    assert sim.checkpoint() == saved
