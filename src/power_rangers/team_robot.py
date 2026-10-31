"""Independent per-leg policies on a shared simulation clock, without barriers."""
from copy import deepcopy
import math
import numpy as np

from .gallop import Gait, PeriodicController, DT, START
from .model import LEGS
from .simulation import Simulation

PERIOD = .48
BASE_OFFSETS = (0., .18, .5, .68)


def seed_plans():
    return {leg: {'offset': BASE_OFFSETS[i], 'swing_s': .1392, 'clearance': .045,
                  'forward_bias': 0., 'lateral_bias': 0., 'placement_gain': .05,
                  'reason': 'Measured starting policy; Ranger has not decided yet'} for i, leg in enumerate(LEGS)}


def validate_plan(plan):
    limits = {'offset': (0, .999), 'swing_s': (.1, .18), 'clearance': (.03, .06),
              'forward_bias': (-.015, .015), 'lateral_bias': (-.008, .008), 'placement_gain': (0, .08)}
    for key, (low, high) in limits.items():
        if type(plan.get(key)) not in (int, float) or not low <= plan[key] <= high:
            raise ValueError(f'Invalid Ranger parameter: {key}')
    if not isinstance(plan.get('reason'), str) or len(plan['reason']) > 500:
        raise ValueError('Expected a short Ranger explanation')


class LegSchedule(Gait):
    def __init__(self, plans):
        if set(plans) != set(LEGS):
            raise ValueError('Each leg needs its own policy')
        for plan in plans.values():
            validate_plan(plan)
        super().__init__(period=PERIOD, duty=.71, height=.3004, clearance=.045, stance_kp=8, pitchweight=400)
        object.__setattr__(self, 'plans', deepcopy(plans))
        object.__setattr__(self, 'offsets', tuple(plans[leg]['offset'] for leg in LEGS))
        object.__setattr__(self, 'locals', {leg: Gait(duty=1-plans[leg]['swing_s']/PERIOD,
            clearance=plans[leg]['clearance'], placement_gain=plans[leg]['placement_gain']) for leg in LEGS})

    def swinging(self, leg, t):
        return t >= START and self.phase(leg, t) >= self.locals[leg].duty

    def for_leg(self, leg):
        return self.locals[leg]

    def foot_bias(self, leg):
        return np.array([self.plans[leg]['forward_bias'], self.plans[leg]['lateral_bias']])

    def to_dict(self):
        return {'period': PERIOD, 'legs': deepcopy(self.plans)}


class TeamRobot(Simulation):
    def __init__(self):
        super().__init__(rig=False)
        self.controller = None
        self.team = {'status': 'ready', 'duration_s': 10., 'policy': None, 'actions': {}, 'events': [],
                     'completed': 0, 'missed': 0, 'max_concurrent': 0, 'max_tilt': 0., 'start_x': float(self.data.qpos[0]),
                     'trace': []}

    def install(self, decisions, duration_s=10.):
        if self.tick != 0:
            raise ValueError('Install a negotiated policy before starting physics')
        if not 2 <= duration_s <= 30:
            raise ValueError('Demo length must be between 2 and 30 seconds')
        plans = {d['leg']: d['plan'] for d in decisions}
        self.controller = PeriodicController(self, LegSchedule(plans))
        self.team.update(status='running', duration_s=duration_s, policy=plans)

    def step(self, ticks=1):
        if not self.controller or self.team['status'] != 'running':
            return
        for _ in range(ticks):
            t = self.tick*DT
            was_swinging = self.controller.previous.copy()
            self.controller.step()
            contacts = self.contacts()
            for leg in LEGS:
                if self.controller.previous[leg] and not was_swinging[leg]:
                    previous = self.team['actions'].get(leg)
                    if previous and previous['status'] == 'active':
                        self._finish(leg, 'late', 'Next scheduled swing arrived before touchdown')
                    local = self.controller.gait.for_leg(leg)
                    remaining = (1-self.controller.gait.phase(leg,t))*PERIOD
                    end_tick = round((t+remaining)/DT)
                    self.team['actions'][leg] = {'id': f'{leg}-{self.tick-1}', 'leg': leg,
                        'start_tick': self.tick-1, 'planned_end_tick': end_tick, 'deadline_tick': end_tick+8,
                        'target': self.controller.plans[leg][1].tolist(), 'duration': (1-local.duty)*PERIOD,
                        'status': 'active', 'saw_air': False, 'contact_ticks': 0}
                action = self.team['actions'].get(leg)
                if action and action['status'] == 'active':
                    action['saw_air'] |= not contacts[leg]
                    action['contact_ticks'] = action['contact_ticks']+1 if contacts[leg] else 0
                    if action['saw_air'] and action['contact_ticks'] >= 2 and self.tick >= action['planned_end_tick']-2:
                        self._finish(leg, 'landed', 'Measured touchdown')
                    elif self.tick >= action['deadline_tick']:
                        self._finish(leg, 'late', 'Touchdown deadline missed; other legs keep their clocks')
            # Measured 20ms samples, persisted with the controller checkpoint so
            # refresh/recovery can draw actual history instead of polling guesses.
            sample = {'tick': self.tick, 'swing': [bool(self.controller.previous[l]) for l in LEGS],
                      'contact': [bool(contacts[l]) for l in LEGS]}
            self.team['trace'] = [*self.team.get('trace', []), sample][-150:]
            tilt = self._tilt()
            self.team['max_tilt'] = max(self.team['max_tilt'], tilt)
            self.team['max_concurrent'] = max(self.team['max_concurrent'], sum(self.controller.previous.values()))
            self.fallen = bool(self.data.qpos[2] < .13 or tilt > 50 or not np.isfinite(self.data.qpos).all())
            if self.fallen:
                self.team['status'] = 'failed'
            elif self.tick*DT >= self.team['duration_s']:
                self.team['status'] = 'completed'
            if self.team['status'] != 'running':
                break

    def _tilt(self):
        return math.degrees(math.acos(float(np.clip(self.data.xmat[self.trunk].reshape(3,3)[2,2], -1, 1))))

    def _finish(self, leg, status, reason):
        action = self.team['actions'][leg]
        action.update(status=status, end_tick=self.tick, reason=reason)
        self.team['completed' if status == 'landed' else 'missed'] += 1
        self.team['events'] = [*self.team['events'], deepcopy(action)][-40:]

    def state(self):
        state = super().state()
        if not hasattr(self, 'team'):
            return state
        state['team'] = deepcopy(self.team)
        state['team']['distance_m'] = float(self.data.qpos[0]-self.team['start_x'])
        state['team']['velocity_m_s'] = float(self.data.qvel[0])
        if self.controller:
            for leg in LEGS:
                local = self.controller.gait.for_leg(leg)
                phase = self.controller.gait.phase(leg, self.tick*DT)
                swinging = self.controller.gait.swinging(leg, self.tick*DT)
                until = ((local.duty-phase)%1)*PERIOD
                state['legs'][leg].update(swinging=swinging, next_swing_s=until,
                    reservation=deepcopy(self.team['actions'].get(leg)),
                    swing_remaining_s=(1-phase)*PERIOD if swinging else 0.)
        return state

    def checkpoint(self):
        cp = super().checkpoint()
        cp['team'] = deepcopy(self.team)
        cp['team_observation'] = {'position': self.data.qpos[:3].tolist(), 'velocity': self.data.qvel[:3].tolist(),
                                  'contacts': self.contacts()}
        if self.controller:
            c = self.controller
            cp['team_controller'] = {
                'joints': c.joints.tolist(), 'forces': c.forces.tolist(), 'B': c.B.tolist(),
                'nominal': {l:v.tolist() for l,v in c.nominal.items()},
                'anchors': {l:v.tolist() for l,v in c.anchors.items()},
                'plans': {l:[a.tolist(), b.tolist()] for l,(a,b) in c.plans.items()}, 'previous': c.previous.copy()}
        return cp

    def restore(self, cp):
        super().restore(cp)
        self.team = deepcopy(cp['team'])
        self.controller = None
        if cp.get('team_controller'):
            self.controller = PeriodicController(self, LegSchedule(self.team['policy']))
            saved = cp['team_controller']
            for key in ('joints', 'forces', 'B'):
                setattr(self.controller, key, np.array(saved[key]))
            for key in ('nominal', 'anchors'):
                setattr(self.controller, key, {l:np.array(v) for l,v in saved[key].items()})
            self.controller.plans = {l:tuple(np.array(v) for v in ab) for l,ab in saved['plans'].items()}
            self.controller.previous = saved['previous'].copy()
