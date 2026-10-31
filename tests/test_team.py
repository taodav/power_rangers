import json
import os
import time
from threading import Lock

import numpy as np
import pytest

from power_rangers.actors import ActorError, TerseRuntime, encode
from power_rangers.team import TeamSession
from power_rangers.team_robot import TeamRobot, LegSchedule, seed_plans


def installed(plans=None):
    robot = TeamRobot()
    robot.install([{'leg': leg, 'plan': plan} for leg, plan in (plans or seed_plans()).items()])
    return robot


def test_leg_timing_is_independent_and_all_four_can_overlap():
    plans = seed_plans()
    for plan in plans.values():
        plan['offset'] = 0
    plans['FR']['swing_s'] = .18
    plans['FL']['swing_s'] = .1
    schedule = LegSchedule(plans)
    assert schedule.swinging('FR', .92)
    assert not schedule.swinging('FL', .92)
    assert all(schedule.swinging(leg, 1.06) for leg in plans)
    # No arbiter silently restores a diagonal pair or equal durations.
    assert schedule.to_dict()['legs'] == plans


def test_late_touchdown_does_not_gate_other_legs(monkeypatch):
    robot = installed()
    real_contacts = robot.contacts
    monkeypatch.setattr(robot, 'contacts', lambda: {**real_contacts(), 'FR': False})
    starts = {leg: [] for leg in seed_plans()}
    for _ in range(150):
        before = robot.controller.previous.copy()
        robot.step()
        for leg, moving in robot.controller.previous.items():
            if moving and not before[leg]:
                starts[leg].append(robot.tick-1)
    assert robot.tick == 150 and not robot.fallen
    assert robot.team['missed'] > 0
    assert all(len(times) >= 4 for times in starts.values())
    assert any(e['leg'] != 'FR' and e['status'] == 'landed' for e in robot.team['events'])
    assert all(np.diff(times).tolist() == [24]*(len(times)-1) for times in starts.values())


def test_exact_checkpoint_with_overlapping_leg_actions():
    robot = installed()
    robot.step(90)
    cp = json.loads(encode(robot.checkpoint()))
    assert robot.team['actions']
    robot.step(30)
    restored = TeamRobot()
    restored.restore(cp)
    restored.step(30)
    assert robot.checkpoint() == restored.checkpoint()
    assert not restored.data.eq_active.any() and not restored.data.xfrc_applied.any()


class FakeBrain:
    def __init__(self):
        self.calls, self.active, self.max_active = [], 0, 0
        self.lock = Lock()

    def decide(self, request):
        context = json.loads(request['contextJson'])
        with self.lock:
            self.calls.append(request['id'])
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(.05)
        plan = seed_plans()[request['leg']]
        if context['round'] >= 2:
            assert context['trial_feedback'] and len(context['peer_proposals']) == 4
            plan['forward_bias'] = .002
            plan['reason'] = 'Adjust my own placement after reading peer plans and measured speed'
        with self.lock:
            self.active -= 1
        return {'request_id': request['id'], 'leg': request['leg'], 'plan': plan,
                'response_id': 'fake-'+request['id'], 'model': 'test-double', 'usage': {}}


@pytest.mark.skipif(os.environ.get('RANGERS_INTEGRATION') != '1', reason='Starts the real local Terse runtime')
def test_four_durable_models_negotiate_and_recover(tmp_path):
    runtime = TerseRuntime(port=0, data_dir=tmp_path/'terse')
    session = None
    try:
        runtime.start()
        robot, brain = TeamRobot(), FakeBrain()
        session = TeamSession.create(robot, runtime, seconds=3., brain=brain)
        deadline = time.monotonic()+100
        while robot.tick < 90:
            assert time.monotonic() < deadline
            session.step()
            if not robot.controller:
                time.sleep(.01)
        assert len(brain.calls) == 12 and len(set(brain.calls)) == 12 and brain.max_active == 4
        assert all(p['forward_bias'] == .002 for p in robot.team['policy'].values())
        result = session.restart()
        assert result['checkpoint_equal'] and result['actors_reactivated'] and result['decisions_preserved']
        while robot.team['status'] == 'running':
            session.step()
        assert robot.team['status'] == 'completed' and robot.team['max_concurrent'] >= 2
        assert len(brain.calls) == 12
        # Another process/session restores the accepted policy without needing a key.
        resumed = TeamSession.resume(TeamRobot(), runtime, brain=brain)
        assert resumed.sim.checkpoint() == robot.checkpoint()
        assert resumed.future is None
        for leg in seed_plans():
            memory = runtime.call('TeamRanger', f'{session.episode}.{leg}', 'inspect')
            assert len(memory['requests']) == 3
            saved = next(iter(memory['requests'].values()))
            wrong = {**saved['decision'], 'leg': 'FL' if leg != 'FL' else 'FR'}
            with pytest.raises(ActorError, match='own leg'):
                runtime.call('TeamRanger', f'{session.episode}.{leg}', 'decide', saved['id'], encode(wrong))
            # Duplicate requests and acknowledgements preserve exactly one decision.
            retried = runtime.call('TeamRanger', f'{session.episode}.{leg}', 'request', saved['contextJson'])
            assert retried['decision'] == saved['decision']
            assert runtime.call('TeamRanger', f'{session.episode}.{leg}', 'decide', saved['id'], encode(saved['decision'])) == saved['decision']
    finally:
        if session:
            session.close()
        runtime.stop()
