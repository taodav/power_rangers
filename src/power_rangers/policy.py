"""Physical observations and local execution of the same TypeScript Ranger policy."""
import json
import math
from pathlib import Path
import shutil
import subprocess

import numpy as np

from .model import LEGS
from .motions import CONTROL_DT
from .gaits import paired_profile

ROOT = Path(__file__).resolve().parents[2]


def validate_goal(goal, policy='reactive', profile='brisk'):
    if not isinstance(goal, dict) or set(goal) != {'vx', 'vy', 'yaw_rate'}:
        raise ValueError('A goal needs vx, vy and yaw_rate')
    bounds = list(zip(('vx','vy','yaw_rate'), paired_profile(profile)['velocity_limits'])) if policy == 'trot' else [('vx', .025), ('vy', .015), ('yaw_rate', .08)]
    if any(type(goal[k]) not in (int, float) or not math.isfinite(goal[k]) or abs(goal[k]) > bound for k, bound in bounds):
        raise ValueError(f'Goal exceeds {policy} limits: {dict(bounds)}')
    return dict(goal)


def configure(sim, policy='reactive', profile='brisk', goal=None):
    if (policy not in ('fixed', 'reactive', 'ordered', 'trot') or profile not in ('baseline', 'brisk', 'fast')
            or profile == 'fast' and policy != 'trot'):
        raise ValueError('Unknown policy/profile')
    goal = validate_goal(goal or {'vx': paired_profile(profile)['default_vx'] if policy == 'trot' else .012, 'vy': 0., 'yaw_rate': 0.}, policy, profile)
    if policy == 'trot':
        from .trot import TrotController
        sim.crawl = TrotController(sim, saved=sim.crawl.snapshot())
    state = sim.crawl.state
    state.policy, state.profile, state.goal = policy, profile, goal
    state.shift_ticks, state.settle_ticks = (30, 8) if profile == 'brisk' else (60, 15)
    sim.crawl.sync_goal_reference(sim)


def observation(sim, episode, revision):
    state = sim.crawl.state
    sim.crawl.sync_goal_reference(sim)
    center, yaw = sim.crawl.formation(sim)
    contacts = sim.contacts()
    feet = {}
    for leg in LEGS:
        previous = next((m for m in reversed(sim.history) if m.leg == leg and m.status == 'completed'), None)
        last_index = next((i for i in range(len(sim.history)-1, -1, -1) if sim.history[i].leg == leg), -1)
        motion = sim.active.get(leg)
        support_center = np.mean([sim.anchors[l][:2] for l in LEGS if l != leg], axis=0)
        feet[leg] = {
            'position': sim.foot(leg).tolist(), 'contact': contacts[leg], 'nominal': state.nominal_feet[leg],
            'last_step': last_index, 'age_ticks': sim.tick - (previous.end_tick if previous else 0),
            'shift_distance': float(np.linalg.norm(support_center - sim.data.subtree_com[sim.trunk][:2])),
            'remaining_ticks': max(0, motion.planned_end_tick - sim.tick) if motion else 0,
            'deadline_tick': motion.deadline_tick if motion else None,
        }
    rotation = sim.data.xmat[sim.trunk].reshape(3, 3)
    return {'episode': episode, 'revision': revision, 'tick': sim.tick, 'step': state.completed_steps,
            'policy': state.policy, 'profile': state.profile, 'goal': state.goal, 'next_pair': state.next_pair,
            'center': center.tolist(), 'formation_yaw': yaw, 'feet': feet,
            'reference_center': state.reference_center, 'reference_yaw': state.reference_yaw,
            'body': {'position': sim.data.qpos[:3].tolist(), 'velocity': sim.data.qvel[:3].tolist(),
                     'yaw': math.atan2(rotation[1, 0], rotation[0, 0]),
                     'tilt_deg': math.degrees(math.acos(float(np.clip(rotation[2, 2], -1, 1)))),
                     'com': sim.data.subtree_com[sim.trunk].tolist()}}


class LocalPolicies:
    """One Bun process, four policy calls per decision; no Terse or model API calls."""
    def __init__(self):
        bun = shutil.which('bun') or str(ROOT / '.cache/bun/bun-darwin-aarch64/bun')
        self.process = subprocess.Popen([bun, '--no-env-file', 'policy-worker.ts'], cwd=ROOT / 'actors',
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.revision = 0

    def decide(self, sim):
        obs = observation(sim, 'evaluation', self.revision)
        self.process.stdin.write(json.dumps(obs, allow_nan=False) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Policy worker stopped: ' + self.process.stderr.read())
        result = json.loads(line)
        if 'error' in result:
            raise ValueError(result['error'])
        self.revision += 1
        if result['selected'] and sim.crawl.state.policy == 'trot':
            sim.crawl.reserve_batch(sim, result['selected'])
        elif result['intent']:
            sim.crawl.reserve_step(sim, result['intent'])
        else:
            sim.crawl.reserve_hold(sim)
        return result

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()
