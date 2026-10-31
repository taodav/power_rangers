"""Real-runtime checks: RANGERS_INTEGRATION=1 uv run pytest tests/test_actors.py -q."""
import json
import os

import numpy as np
import pytest

from power_rangers.actors import ActorError, ActorSession, TerseRuntime, encode
from power_rangers.crawl import ORDER
from power_rangers.model import LEGS
from power_rangers.simulation import Simulation

pytestmark = pytest.mark.skipif(os.environ.get('RANGERS_INTEGRATION') != '1',
                                reason='Explicit opt-in: starts the real local Terse runtime')


@pytest.fixture(scope='module')
def runtime(tmp_path_factory):
    runtime = TerseRuntime(port=0, data_dir=tmp_path_factory.mktemp('terse'))
    runtime.start()
    yield runtime
    runtime.stop()


@pytest.fixture
def session(runtime):
    return ActorSession.create(Simulation(rig=False), runtime, 1)


def test_gait_search_journal_survives_restart_and_rejects_conflicts(runtime):
    value = encode({'gait': {'period': .5}, 'speed': .15})
    assert runtime.call('GaitSearch', 'search-test', 'put', 'trial-1', value)['speed'] == .15
    runtime.restart()
    assert runtime.call('GaitSearch', 'search-test', 'inspect')['trial-1'] == value
    assert runtime.call('GaitSearch', 'search-test', 'put', 'trial-1', value)['speed'] == .15
    with pytest.raises(ActorError, match='Conflicting'):
        runtime.call('GaitSearch', 'search-test', 'put', 'trial-1', encode({'speed': .3}))


def finish(session):
    for _ in range(1400):
        if session.sim.crawl.state.status != 'running':
            return
        session.step()
    pytest.fail('Actor crawl exceeded its time budget')


def test_real_actors_crawl_and_survive_runtime_crash(session):
    while session.sim.tick < 85:
        session.step()
    assert session.sim.active
    result = session.restart_demo(crash=True)
    assert result['active_ids']
    assert all(result[key] for key in ('checkpoint_equal', 'body_reactivated', 'rangers_reactivated', 'decisions_preserved'))
    finish(session)
    sim = session.sim
    assert sim.crawl.state.status == 'completed'
    assert [m.leg for m in sim.history] == list(ORDER)
    assert len({m.action_id for m in sim.history}) == 4
    assert all(m.status == 'completed' for m in sim.history)
    assert sim.crawl.telemetry(sim)['forward_m'] > .08
    assert sim.crawl.state.max_tilt_deg < 5
    assert all(sim.contacts().values()) and not sim.fallen
    assert not sim.data.eq_active.any() and not sim.data.xfrc_applied.any()
    # Four durable policy memories, each with four unique decision rounds.
    for leg in LEGS:
        memory = session.runtime.call('Ranger', f'{session.episode}.{leg}', 'inspect')
        assert memory['decisions'] == 4
    # Durable result survives constructing an entirely new simulator/worker.
    restored = ActorSession.resume(Simulation(), session.runtime, session.episode)
    assert restored.sim.checkpoint() == sim.checkpoint()


def test_mid_round_crash_replays_only_uncommitted_physics(session):
    while session.sim.tick < 85:
        session.step()
    session.flush()
    session.step()  # tick 86, prepared round persisted; physics not committed yet
    assert session.pending and json.loads(session.record['checkpoint'])['tick'] == 85
    first_attempt = session.sim.checkpoint()
    ranger_before = session.runtime.call('Ranger', f'{session.episode}.RL', 'inspect')
    session.runtime.restart(crash=True)
    session.recover()
    assert session.sim.tick == 85 and session.record['pending']
    session.step()
    assert session.sim.checkpoint() == first_attempt
    ranger_after = session.runtime.call('Ranger', f'{session.episode}.RL', 'inspect')
    assert ranger_after['decisions'] == ranger_before['decisions']
    assert len(session.sim.active) == 1
    session.flush()


def test_duplicate_commit_and_lost_ack_do_not_advance_twice(session):
    session.step()
    pending = session.pending['id']
    cp, events = encode(session.sim.checkpoint()), encode(session.events)
    committed = session.runtime.call('Body', session.episode, 'commit', pending, cp, events)
    again = session.runtime.call('Body', session.episode, 'commit', pending, cp, events)
    assert again == committed and again['revision'] == 1
    changed = json.loads(cp)
    changed['tick'] += 1
    with pytest.raises(ActorError, match='Conflicting commit retry'):
        session.runtime.call('Body', session.episode, 'commit', pending, encode(changed), events)
    # Worker never saw the acknowledgement; recover committed state, not old work.
    session.recover()
    assert session.sim.tick == 1 and session.record['pending'] is None


def test_stale_and_conflicting_proposals_are_rejected(session):
    obs = dict(episode=session.episode, revision=0, tick=0, step=0)
    intents = [session.runtime.call('Ranger', f'{session.episode}.{leg}', 'propose', encode(obs)) for leg in LEGS]
    assert sum(i['kind'] == 'step' for i in intents) == 1
    duplicate = session.runtime.call('Ranger', f'{session.episode}.RL', 'propose', encode(obs))
    assert duplicate == intents[3]
    with pytest.raises(ActorError, match='Conflicting observation'):
        session.runtime.call('Ranger', f'{session.episode}.RL', 'propose', encode({**obs, 'tick': 1}))
    intents[0]['revision'] = 1
    with pytest.raises(ActorError, match='Stale or invalid'):
        session.runtime.call('Body', session.episode, 'prepare', 0, encode(intents))
    assert session.runtime.call('Body', session.episode, 'inspect')['pending'] is None
    intents[0]['revision'] = 0
    # Two Rangers request a step: the arbiter reserves one, records the other wait.
    intents[0]['kind'] = 'step'
    pending = session.runtime.call('Body', session.episode, 'prepare', 0, encode(intents))
    assert pending['intent']['leg'] == 'FR'
    stored = session.runtime.call('Body', session.episode, 'inspect')
    assert len([e for e in stored['timeline'] if e['kind'] == 'reserved']) == 1
    assert session.runtime.call('Body', session.episode, 'prepare', 0, encode(intents)) == pending
    with pytest.raises(ActorError, match='Stale Body'):
        session.runtime.call('Body', session.episode, 'prepare', 1, encode(intents))


def test_safe_stop_is_durable_during_swing(session):
    while session.sim.tick < 85:
        session.step()
    session.request_stop()
    session.recover()
    finish(session)
    assert session.sim.crawl.state.status == 'stopped'
    assert len(session.sim.history) == 1
    assert session.sim.history[0].status == 'completed'
    assert all(session.sim.contacts().values())


def test_actor_motion_matches_local_scripted_reference(session):
    finish(session)
    baseline = Simulation(rig=False)
    baseline.start_crawl(1)
    for _ in range(1200):
        baseline.step()
        if baseline.crawl.state.status != 'running': break
    assert baseline.crawl.state.status == 'completed'
    assert [m.leg for m in session.sim.history] == [m.leg for m in baseline.history]
    # A decision boundary can shift a control tick; compare motion within 2mm.
    np.testing.assert_allclose(session.sim.data.qpos[:3], baseline.data.qpos[:3], atol=.002)


def test_reactive_goal_changes_and_hold_survive_actor_restart(runtime):
    from power_rangers.policy import observation
    session = ActorSession.create(Simulation(rig=False), runtime, 3, policy='reactive', profile='brisk',
                                  goal={'vx':0.,'vy':0.,'yaw_rate':0.})
    for _ in range(60): session.step()
    assert session.sim.tick >= 55 and not session.sim.history
    session.flush()
    obsolete_revision = session.record['revision']
    obs = encode(observation(session.sim, session.episode, obsolete_revision))
    # Generate old proposals, then change the shared goal; old proposals must lose authority.
    stale = [runtime.call('Ranger', f'{session.episode}.{leg}', 'propose', obs) for leg in LEGS]
    session.set_goal({'vx':.012,'vy':0.,'yaw_rate':0.})
    with pytest.raises(ActorError, match='Stale Body'):
        runtime.call('Body', session.episode, 'prepare', obsolete_revision, encode(stale))
    for _ in range(250):
        session.step()
        if session.sim.active: break
    assert session.sim.active
    target = next(iter(session.sim.active.values())).target.copy()
    session.set_goal({'vx':0.,'vy':0.,'yaw_rate':-.04})
    assert next(iter(session.sim.active.values())).target == target
    result = session.restart_demo()
    assert result['checkpoint_equal'] and result['decisions_preserved']
    assert session.sim.crawl.state.goal['yaw_rate'] == -.04
    finish(session)
    assert session.sim.crawl.state.status == 'completed'
    assert session.sim.crawl.telemetry(session.sim)['yaw_deg'] < -20
    assert len({m.action_id for m in session.sim.history}) == 12


@pytest.mark.parametrize('profile', ['brisk', 'fast'])
def test_diagonal_pair_reservation_replay_restart_and_stop(runtime, profile):
    session = ActorSession.create(Simulation(rig=False), runtime, 3, policy='trot', profile=profile)
    session.step()
    assert {i['leg'] for i in session.pending['intents']} == {'FR','RL'}
    first_attempt = session.sim.checkpoint()
    # The uncommitted pair reservation is durable and replays as one batch.
    session.recover()
    assert session.sim.tick == 0
    session.step()
    assert session.sim.checkpoint() == first_attempt
    for _ in range(150):
        session.step()
        if len(session.sim.active) == 2 and all(not session.sim.contacts()[l] for l in session.sim.active): break
    assert len(session.sim.active) == 2
    targets = {l:list(m.target) for l,m in session.sim.active.items()}
    starts = {m.start_tick for m in session.sim.active.values()}
    assert len(starts) == 1
    session.set_goal({'vx':0.,'vy':0.,'yaw_rate':.12})
    assert {l:m.target for l,m in session.sim.active.items()} == targets
    result = session.restart_demo()
    assert len(result['active_ids']) == 2
    assert result['checkpoint_equal'] and result['decisions_preserved']
    session.request_stop()
    session.recover()
    finish(session)
    assert session.sim.crawl.state.status == 'stopped'
    assert len(session.sim.history) == 2
    assert all(m.status == 'completed' for m in session.sim.history)
    assert all(session.sim.contacts().values())
    assert session.sim.crawl.state.max_concurrent_swings == 2
    assert session.sim.crawl.state.concurrent_air_ticks > 0


def test_body_never_reserves_half_a_diagonal_pair(runtime):
    from power_rangers.policy import observation
    session = ActorSession.create(Simulation(rig=False), runtime, 1, policy='trot', profile='brisk')
    obs = encode(observation(session.sim, session.episode, 0))
    intents = [runtime.call('Ranger', f'{session.episode}.{leg}', 'propose', obs) for leg in LEGS]
    assert {i['leg'] for i in intents if i['kind']=='step'} == {'FR','RL'}
    next(i for i in intents if i['leg']=='RL')['kind'] = 'wait'
    pending = runtime.call('Body', session.episode, 'prepare', 0, encode(intents))
    assert pending['intents'] == [] and pending['intent'] is None
    session.recover()
    session.step()
    assert not session.sim.active and session.sim.crawl.state.phase == 'goal_hold'
