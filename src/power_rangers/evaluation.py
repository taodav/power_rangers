"""Reproducible flat-ground policy comparisons using the real policy and physics."""
import json
import time
from pathlib import Path
from statistics import mean

import mujoco
import numpy as np

from .policy import LocalPolicies, configure
from .simulation import Simulation

SCENARIOS = {
    'forward': {'vx': .012, 'vy': 0., 'yaw_rate': 0.},
    'reverse': {'vx': -.012, 'vy': 0., 'yaw_rate': 0.},
    'left_turn': {'vx': 0., 'vy': 0., 'yaw_rate': .04},
    'right_turn': {'vx': 0., 'vy': 0., 'yaw_rate': -.04},
    'side_left': {'vx': 0., 'vy': .008, 'yaw_rate': 0.},
    'side_right': {'vx': 0., 'vy': -.008, 'yaw_rate': 0.},
    'curve': {'vx': .01, 'vy': 0., 'yaw_rate': .025},
}

PAIRED_SCENARIOS = {
    'forward_fast': {'vx': .05, 'vy': 0., 'yaw_rate': 0.},
    'reverse_fast': {'vx': -.05, 'vy': 0., 'yaw_rate': 0.},
    'side_left_fast': {'vx': 0., 'vy': .025, 'yaw_rate': 0.},
    'side_right_fast': {'vx': 0., 'vy': -.025, 'yaw_rate': 0.},
    'left_turn_fast': {'vx': 0., 'vy': 0., 'yaw_rate': .12},
    'right_turn_fast': {'vx': 0., 'vy': 0., 'yaw_rate': -.12},
    'curve_fast': {'vx': .04, 'vy': 0., 'yaw_rate': .10},
}


def rollout(worker, policy, profile, goal, seed, cycles=6):
    sim = Simulation(rig=False)
    sim.data.qvel[:6] = np.random.default_rng(seed).normal(0, .015, 6)
    sim.start_crawl(cycles, external_policy=True)
    configure(sim, policy, profile, goal)
    started = time.perf_counter()
    samples = []
    decisions, holds = 0, 0
    for _ in range(cycles * 1200 + 300):
        if sim.crawl.state.phase == 'awaiting_decision':
            decision = worker.decide(sim)
            decisions += 1
            holds += int(decision['intent'] is None)
        sim.step()
        if 4 <= sim.crawl.state.completed_steps < cycles * 4:
            samples.append((sim.tick * .02, *sim.data.qpos[:2]))
        if sim.crawl.state.status != 'running':
            break
    report = sim.crawl.telemetry(sim)
    report.pop('events')
    velocity = [0., 0.]
    if len(samples) > 5:
        trajectory = np.array(samples)
        velocity = np.polyfit(trajectory[:, 0] - trajectory[0, 0], trajectory[:, 1:], 1)[0].tolist()
    report.update(seed=seed, fallen=sim.fallen, decision_rounds=decisions, holds=holds,
                  steady_velocity_world_m_s=velocity,
                  wall_seconds=time.perf_counter()-started,
                  step_order=[m.leg for m in sim.history],
                  touchdown_count=sum(m.status == 'completed' for m in sim.history),
                  max_actual_swing_s=max(((m.end_tick-m.start_tick)*.02 for m in sim.history), default=0),
                  calibration_rig=bool(sim.data.eq_active.any()),
                  external_forces=bool(sim.data.xfrc_applied.any() or sim.data.qfrc_applied.any()))
    return report


def evaluate(output: Path, seeds=5, cycles=6, suite='reactive'):
    if not 1 <= seeds <= 50 or not 2 <= cycles <= 20:
        raise ValueError('Use 1–50 seeds and 2–20 cycles')
    worker = LocalPolicies()
    results = []
    cases = []
    if suite == 'paired':
        # Retain the previous default and compare both gaits at the same higher
        # goal as well as the new pair controller's faster default.
        cases = [('forward', 'reactive', 'brisk', SCENARIOS['forward'])]
        for policy in ('reactive', 'trot'):
            cases.append(('forward_same_goal', policy, 'brisk', {'vx':.025, 'vy':0., 'yaw_rate':0.}))
        cases.extend((name, 'trot', 'brisk', goal) for name,goal in PAIRED_SCENARIOS.items())
    elif suite == 'reactive':
        cases = [('forward',policy,profile,SCENARIOS['forward']) for policy,profile in
                 [('fixed','baseline'),('fixed','brisk'),('ordered','brisk'),('reactive','baseline'),('reactive','brisk')]]
        cases.extend((name,'reactive','brisk',goal) for name,goal in SCENARIOS.items() if name != 'forward')
    else:
        worker.close()
        raise ValueError('Unknown evaluation suite')
    try:
        for scenario,policy,profile,goal in cases:
            for seed in range(seeds):
                results.append({'scenario': scenario, **rollout(worker, policy, profile, goal, seed, cycles)})
            group = results[-seeds:]
            print(f'{scenario:20} {policy:8} {profile:8}: {sum(r["status"] == "completed" for r in group)}/{seeds} completed; '
                  f'{100*mean(r["steady_velocity_world_m_s"][0] for r in group):.3f} cm/s steady', flush=True)
    finally:
        worker.close()
    summary = []
    for key in dict.fromkeys((r['scenario'], r['policy'], r['profile']) for r in results):
        group = [r for r in results if (r['scenario'],r['policy'],r['profile']) == key]
        summary.append({'scenario':key[0], 'policy':key[1], 'profile':key[2], 'trials':len(group),
                        'completed':sum(r['status']=='completed' for r in group),
                        'falls':sum(r['fallen'] for r in group),
                        'steady_vx_cm_s':100*mean(r['steady_velocity_world_m_s'][0] for r in group),
                        'steady_vy_cm_s':100*mean(r['steady_velocity_world_m_s'][1] for r in group),
                        'mean_yaw_deg':mean(r['yaw_deg'] for r in group),
                        'max_concurrent_swings':max(r['max_concurrent_swings'] for r in group),
                        'mean_concurrent_air_s':mean(r['concurrent_air_s'] for r in group),
                        'max_tilt_deg':max(r['max_tilt_deg'] for r in group),
                        'mean_mechanical_work_j':mean(r['mechanical_work_j'] for r in group)})
    payload = {'mujoco_version':mujoco.__version__, 'backend':'native', 'cycles':cycles, 'suite':suite,
               'description':'Same TypeScript Ranger functions as Terse; local RPC-free policy worker. Flat floor, 0.015 std initial base-velocity perturbations. Not a wall-clock Terse throughput benchmark.',
               'steady_speed_definition':'Least-squares slope of actual body x/y after the fourth touchdown, before the final touchdown; excludes initial cycle and final recentering.',
               'work_definition':'Integral of absolute generalized actuator torque times joint velocity, joules; not electrical consumption.',
               'summary':summary, 'runs':results}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2)+'\n')
    if any(r['status'] != 'completed' or r['fallen'] or r['calibration_rig'] or r['external_forces'] for r in results):
        raise SystemExit('Evaluation had failures; inspect '+str(output))
