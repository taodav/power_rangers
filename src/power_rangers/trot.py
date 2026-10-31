"""Contact-gated diagonal pairs with actuator-only two-foot stance control.

Both reservations start on the same simulation tick. The opposite diagonal
continues supporting the body; neither next pair nor stop can interrupt landing.
This is a conservative paired gait, not a flight-phase running controller.
"""
import math

import numpy as np

from .crawl import CrawlController
from .model import LEGS
from .motions import smoothstep

PAIRS = (("FR", "RL"), ("FL", "RR"))


class TrotController(CrawlController):
    def _begin_shift(self, sim, center=False):
        if center:
            self.state.selected_legs = []
            self.state.selected_leg = None
        super()._begin_shift(sim, center)

    def reserve_batch(self, sim, intents):
        state = self.state
        if state.phase != "awaiting_decision" or sim.active:
            raise ValueError("Executor is not awaiting a pair decision")
        expected = set(PAIRS[state.next_pair])
        if len(intents) != 2 or {i['leg'] for i in intents} != expected:
            raise ValueError("Reserve the complete next diagonal pair")
        for intent in intents:
            target = np.asarray(intent.get('target'), dtype=float)
            if (target.shape != (3,) or not np.isfinite(target).all()
                    or np.linalg.norm(target - sim.foot(intent['leg'])) > .085):
                raise ValueError("Foot target exceeds pair workspace")
            if not (.2 <= intent['duration'] <= .4 and .015 <= intent['clearance'] <= .04):
                raise ValueError("Invalid paired swing timing/clearance")
        if len({(i['duration'], i['clearance']) for i in intents}) != 1:
            raise ValueError("Pair must agree on swing timing")
        state.selected_legs = list(PAIRS[state.next_pair])
        state.selected_leg = state.selected_legs[0]
        state.batch_intents = intents
        state.motion_ids = []
        state.shift_origin = list(state.body_target)
        supports = [sim.anchors[l] for l in LEGS if l not in expected]
        # Put the desired COM above the opposite diagonal's midpoint.
        target = np.mean(supports, axis=0)
        target[2] = .27
        target[:2] -= np.array(state.com_offset)[:2]
        state.shift_target = target.tolist()
        state.yaw_origin = 2 * math.atan2(state.quaternion[3], state.quaternion[0])
        yaw = self.formation(sim)[1]
        state.yaw_target = state.yaw_origin + float(np.clip(math.atan2(math.sin(yaw-state.yaw_origin), math.cos(yaw-state.yaw_origin)), -.08, .08))
        state.shift_ticks = 25 if state.completed_steps == 0 else 10
        self._event(sim, 'pair_shift')

    def prepare(self, sim):
        state = self.state
        if state.status != 'running':
            return
        if state.phase not in ('pair_shift', 'pair_swing', 'pair_touchdown'):
            super().prepare(sim)
            return
        self.sync_goal_reference(sim)
        elapsed = sim.tick - state.phase_start
        if state.phase == 'pair_shift':
            if state.stop_requested:
                state.shift_ticks = 25
                self._begin_shift(sim, center=True)
                return
            fraction = smoothstep((elapsed+1) / state.shift_ticks)
            state.body_target = (np.array(state.shift_origin) + fraction*(np.array(state.shift_target)-state.shift_origin)).tolist()
            yaw = state.yaw_origin + fraction*(state.yaw_target-state.yaw_origin)
            state.quaternion = [math.cos(yaw/2), 0, 0, math.sin(yaw/2)]
            contact = sim.contacts()
            supports = [sim.foot(l)[:2] for l in LEGS if l not in state.selected_legs]
            a, b = supports
            line = b-a
            com = sim.data.subtree_com[sim.trunk][:2]
            relative = com-a
            line_error = abs(line[0]*relative[1] - line[1]*relative[0]) / np.linalg.norm(line)
            ready = elapsed >= state.shift_ticks and all(contact.values()) and line_error < .012
            state.ready_ticks = state.ready_ticks+1 if ready else 0
            if state.ready_ticks >= 2:
                for intent in state.batch_intents:
                    motion = sim._start_motion(intent['leg'], duration=intent['duration'], forward=0, clearance=intent['clearance'])
                    motion.target = list(intent['target'])
                    motion.action_id = intent['id']
                    state.motion_ids.append(motion.action_id)
                self._event(sim, 'pair_swing')
            elif elapsed >= 100:
                self.fail(sim, 'diagonal support alignment timed out')
        elif state.phase == 'pair_touchdown':
            state.ready_ticks = state.ready_ticks+1 if all(sim.contacts().values()) else 0
            if elapsed >= 4 and state.ready_ticks >= 2:
                state.selected_legs = []
                state.selected_leg = None
                if state.stop_requested or state.completed_steps >= state.cycles*4:
                    state.shift_ticks = 25
                    self._begin_shift(sim, center=True)
                else:
                    self._event(sim, 'awaiting_decision')
            elif elapsed >= 50:
                self.fail(sim, 'pair support transfer timed out')

    def observe(self, sim):
        super().observe(sim)
        state = self.state
        if state.status != 'running' or state.phase != 'pair_swing':
            return
        results = [m for m in sim.history if m.action_id in state.motion_ids]
        if any(m.status != 'completed' for m in results):
            self.fail(sim, 'one member of the diagonal pair failed to land')
        elif not sim.active:
            if len(results) != 2:
                self.fail(sim, 'missing paired swing result')
                return
            state.completed_steps += 2
            state.next_pair = 1-state.next_pair
            self._event(sim, 'pair_touchdown')
