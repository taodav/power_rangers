"""Four durable Ranger contexts with parallel, independent model decisions."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
from threading import Event, Lock
import uuid

from .actors import ActorError, encode
from .gait_search import OpenAIProposer, api_key, object_schema
from .gallop import compact, evaluate
from .model import LEGS
from .team_robot import LegSchedule, seed_plans, validate_plan

INSTRUCTIONS = """You are one durable Ranger controlling exactly ONE leg of a Go1 robot.
Other Rangers control the other three legs. You can read their proposals but may only change your own.
Choose your own periodic swing timing and world-space foot-placement offsets for a 10-second forward run.
The common cycle is .48s, beginning after .6s of standing. phase=((t-.6)/.48+offset)%1.
Your leg swings when phase >= 1-swing_s/.48. Increasing offset moves YOUR swing earlier.
There is NO next-pair order, no global touchdown barrier, and no minimum stance-foot constraint.
All legs can overlap. Your policy repeats on its own clock; a late touchdown never delays another leg.
Actual durations/contacts are measured independently. Stable coordination is your shared responsibility.
A shared numerical MPC balances the robot at25Hz and IK runs at50Hz. It can handle aerial phases,
but aggressive timing can still make the robot fall. No external forces or altered torque limits.
The body wants vx=.2m/s, height=.3004m. Each liftoff targets current COM + nominal leg offset
 + measured velocity*(swing_s+.5*(.48-swing_s)) + placement_gain*(measured-desired velocity)
 + [forward_bias,lateral_bias]. The target ground height is .02m. Clearance lifts the swing arc.
The observed starting policy was measured in simulation. Use it as a conservative starting point;
you own your parameters and may revise them to improve progress, coordination and stability.
Round0: independently propose your leg's policy. Later rounds: read all peers and revise ONLY your
own proposal, explaining what you kept or changed to coordinate. The Body checks bounds; it does
not select leg phases or rewrite your output. Two six-second simulator trials check the joint policy.
After successful trial feedback, address the measured gap between forward speed and the .2m/s goal
with a small, concrete change to your own placement or timing. Prefer one controlled change over
changing everything at once. You are optimizing a joint policy, not merely signing off on the seed.
If trial feedback reports failure, use the supplied metrics to repair your own timing or placement.
Return only your leg's policy using propose_leg. The reason is a short user-visible decision explanation,
not internal reasoning. Do not claim a simulation result that has not been measured.
"""


def leg_tool():
    limits = {'offset': (0, .999), 'swing_s': (.1, .18), 'clearance': (.03, .06),
              'forward_bias': (-.015, .015), 'lateral_bias': (-.008, .008), 'placement_gain': (0, .08)}
    fields = {k: {'type': 'number', 'minimum': a, 'maximum': b} for k,(a,b) in limits.items()}
    fields['reason'] = {'type': 'string', 'maxLength': 500}
    return {'type': 'function', 'name': 'propose_leg', 'description': 'Propose only your own leg policy',
            'strict': True, 'parameters': object_schema(fields)}


class LegBrain:
    def __init__(self, model='gpt-6-astra'):
        self.client = OpenAIProposer(model, api_key())

    def decide(self, request):
        result = self.client.request({'model': self.client.model, 'instructions': INSTRUCTIONS,
            'input': encode({'your_leg': request['leg'], 'durable_context': json.loads(request['contextJson']),
                             'your_previous_decisions': request['previous']}),
            'reasoning': {'effort': 'low'}, 'max_output_tokens': 1800, 'store': False,
            'tools': [leg_tool()], 'parallel_tool_calls': False,
            'tool_choice': {'type': 'function', 'name': 'propose_leg'}})
        calls = [x for x in result.get('output', []) if x.get('type') == 'function_call' and x.get('name') == 'propose_leg']
        if result.get('status') != 'completed' or len(calls) != 1:
            raise ActorError('A Ranger model response did not complete; no policy was substituted')
        plan = json.loads(calls[0]['arguments'])
        validate_plan(plan)
        return {'request_id': request['id'], 'leg': request['leg'], 'plan': plan,
                'response_id': result['id'], 'model': result['model'], 'usage': result.get('usage', {})}


class TeamSession:
    def __init__(self, sim, runtime, episode, brain=None, seconds=10.):
        self.sim, self.runtime, self.episode = sim, runtime, episode
        self.brain, self.seconds = brain, seconds
        self.record, self.pending = None, None
        self.future, self.pool = None, None
        self.cancelled = Event()
        self.lock = Lock()
        self.progress = {'stage': 'ready', 'round': 0, 'legs': {}, 'message': ''}
        self.error = None
        self.recovery = None
        self.latest = Path(runtime.data_dir) / 'latest-team.json'

    @classmethod
    def create(cls, sim, runtime, seconds=10., brain=None):
        session = cls(sim, runtime, uuid.uuid4().hex, brain or LegBrain(), seconds)
        session.record = runtime.call('TeamBody', session.episode, 'initialize', encode(sim.checkpoint()))
        session.latest.parent.mkdir(parents=True, exist_ok=True)
        temp = session.latest.with_suffix('.tmp')
        temp.write_text(encode({'episode': session.episode, 'seconds': seconds}))
        temp.replace(session.latest)
        session.begin_planning()
        return session

    @classmethod
    def resume(cls, sim, runtime, brain=None):
        latest = Path(runtime.data_dir) / 'latest-team.json'
        if not latest.exists():
            raise ValueError('No saved team episode yet; run a demo first')
        saved = json.loads(latest.read_text())
        session = cls(sim, runtime, saved['episode'], brain, saved['seconds'])
        session.recover()
        if not session.record['agreement'] and not session.record['stopped']:
            session.brain = brain or LegBrain()
            session.begin_planning()
        return session

    def _progress(self, **values):
        with self.lock:
            self.progress.update(values)

    def _leg_progress(self, leg, value):
        with self.lock:
            self.progress['legs'][leg] = value

    def begin_planning(self):
        if self.future:
            return
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='ranger-negotiation')
        self.future = self.pool.submit(self._negotiate)

    def _negotiate(self):
        state = self.runtime.call('TeamBody', self.episode, 'inspect')
        initial_cp = json.loads(state['checkpoint'])
        for round_index in range(4):
            if self.cancelled.is_set():
                return None
            existing = next((r for r in state['rounds'] if r['round'] == round_index), None)
            if existing:
                if round_index < state['draft']['round']:
                    continue
                decisions = existing['decisions']
            else:
                peers = state['draft']['decisions'] if state['draft'] else []
                context = {'episode': self.episode, 'round': round_index, 'goal': 'Walk forward together',
                    'simulation_tick': 0, 'cycle_s': .48, 'body': initial_cp['team_observation'],
                    'initial_feet': initial_cp['anchors'], 'starting_policy': seed_plans(), 'peer_proposals': peers,
                    'trial_feedback': state['validation']['results'] if state['validation'] else None}
                self._progress(stage='proposing' if round_index == 0 else 'negotiating', round=round_index,
                               message='Each Ranger proposes independently' if round_index == 0 else 'Rangers read their peers and revise their own plans',
                               legs={leg: {'status': 'thinking'} for leg in LEGS})
                def decide(leg):
                    request = self.runtime.call('TeamRanger', f'{self.episode}.{leg}', 'request', encode(context))
                    decision = request['decision']
                    if not decision:
                        if self.cancelled.is_set():
                            return None
                        decision = self.brain.decide(request)
                        decision = self.runtime.call('TeamRanger', f'{self.episode}.{leg}', 'decide', request['id'], encode(decision))
                    self._leg_progress(leg, {'status': 'proposed', 'decision': decision})
                    return decision
                with ThreadPoolExecutor(max_workers=4, thread_name_prefix='ranger') as workers:
                    decisions = list(workers.map(decide, LEGS))
                if self.cancelled.is_set():
                    return None
                state = self.runtime.call('TeamBody', self.episode, 'publish', round_index, encode(decisions))
            if round_index == 0:
                continue
            if state['validation'] and state['validation']['round'] == round_index:
                results = state['validation']['results']
            else:
                self._progress(stage='checking', round=round_index, message='Testing the joint policy in unassisted MuJoCo')
                schedule = LegSchedule({d['leg']: d['plan'] for d in decisions})
                results = []
                for seed in (0, 1):
                    if self.cancelled.is_set():
                        return None
                    results.append(compact(evaluate(schedule, 6., seed)))
                if self.cancelled.is_set():
                    return None
                state = self.runtime.call('TeamBody', self.episode, 'validate', round_index, encode(results))
            # Require one feedback-driven refinement pass, even when the seed works.
            if state['validation']['accepted'] and round_index >= 2:
                self._progress(stage='ready', message='Four independently timed policies agreed and tested')
                return state
        raise ActorError('Rangers did not find a stable joint policy within four planning passes. No scripted fallback was used.')

    def step(self):
        if self.error or self.record['stopped']:
            return False
        try:
            if not self.record['agreement']:
                if not self.future or not self.future.done():
                    return False
                state = self.future.result()
                if state is None:
                    return False
                self.sim.install(state['draft']['decisions'], self.seconds)
                self.record = self.runtime.call('TeamBody', self.episode, 'agree', encode(self.sim.checkpoint()))
                self.pool.shutdown(wait=False)
                self.pool = None
                self._progress(stage='running', message='Independent leg clocks · no touchdown barrier')
            if self.sim.team['status'] != 'running':
                return False
            if self.pending is None:
                self.pending = self.runtime.call('TeamBody', self.episode, 'prepare', self.record['revision'])
                self.before_tick = self.sim.tick
            self.sim.step()
            if self.sim.tick-self.before_tick >= 5 or self.sim.team['status'] != 'running':
                self.flush()
            if self.sim.team['status'] != 'running':
                self._progress(stage=self.sim.team['status'])
            return True
        except Exception as error:
            self.error = str(error)
            self._progress(stage='error', message=self.error)
            raise ActorError(self.error) from error

    def flush(self):
        if self.pending:
            self.record = self.runtime.call('TeamBody', self.episode, 'commit', self.pending['id'], encode(self.sim.checkpoint()))
            self.pending = None

    def stop(self):
        self.cancelled.set()
        self.flush()
        self.record = self.runtime.call('TeamBody', self.episode, 'stop')
        self._progress(stage='stopped', message='Demo stopped')

    def recover(self):
        self.record = self.runtime.call('TeamBody', self.episode, 'inspect')
        self.sim.restore(json.loads(self.record['checkpoint']))
        self.pending, self.error = None, None
        self._progress(stage='stopped' if self.record['stopped'] else self.sim.team['status'], message='Restored from durable state')

    def restart(self):
        if self.future and not self.future.done():
            raise ValueError('Wait for the planning pass before restarting actors')
        self.flush()
        before = self.sim.checkpoint()
        identities = {leg: self.runtime.call('TeamRanger', f'{self.episode}.{leg}', 'inspect') for leg in LEGS}
        self.runtime.restart()
        self.recover()
        after = {leg: self.runtime.call('TeamRanger', f'{self.episode}.{leg}', 'inspect') for leg in LEGS}
        self.recovery = {'tick': self.sim.tick, 'checkpoint_equal': before == self.sim.checkpoint(),
            'actors_reactivated': all(identities[l]['activation'] != after[l]['activation'] for l in LEGS),
            'decisions_preserved': all(identities[l]['requests'] == after[l]['requests'] for l in LEGS)}
        if not all(self.recovery[k] for k in ('checkpoint_equal', 'actors_reactivated', 'decisions_preserved')):
            raise ActorError('Recovery verification failed')
        return self.recovery

    def telemetry(self):
        with self.lock:
            progress = deepcopy(self.progress)
        return {'episode': self.episode, 'revision': self.record['revision'],
            'committed_tick': json.loads(self.record['checkpoint'])['tick'], 'planning': progress,
            'agreement': self.record['agreement'], 'validation': self.record['validation'],
            'rounds': self.record['rounds'], 'stopped': self.record['stopped'],
            'error': self.error, 'recovery': self.recovery}

    def close(self):
        self.cancelled.set()
        self.flush()
        if self.pool:
            self.pool.shutdown(wait=False, cancel_futures=True)
