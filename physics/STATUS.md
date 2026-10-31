# MuJoCo combined-walking milestone

Measured October 31, 2026. Conor requested real robotics for combined patrol and tighter interlocking joints. Both now have a first implementation; the entire assembly sequence is **not** physical yet.

The next prioritized milestone is independent physical builders. The separate headless one-Ranger pickup/carry result is documented in [RANGER-STATUS.md](RANGER-STATUS.md); it does not silently change the browser world's kinematic independent mode.

## Implemented

- Closer arm/leg mounts, a shorter torso/neck stack, and visible shoulder/hip collars in the decorative assembly model.
- A separate native MuJoCo biped: one free root, two six-joint legs, two two-joint arms, gravity, ground contact, finite torque limits, and non-adjacent self-contact. Adjacent collar/torso overlaps have explicit exclusions; no constraint connects the robot to the world.
- A numeric contact-gated stepping controller. Every counted step has measured airborne samples, more than 2 cm sole-center clearance, forward foot travel, and touchdown. A position target is not treated as proof of movement.
- Four existing Terse actors own the two arm-balance goals and the step/support leg intents. Each new step waits for all four persisted authorizations. One shared low-level controller computes IK/servo targets; the four actors are not independent torque-level controllers.
- The world UI's **Walk in MuJoCo** action starts that rig and renders its actual geometry transforms. **Finish & hold**, physical pause, telemetry, and return to the visual separation sequence work. The old scripted combined root path is removed.

## Measured evidence

- **80-second native walking trial**, plus 1.5 seconds of initial settling: **21 confirmed alternating steps, 2.323 m forward travel, maximum torso tilt 5.479°**. All 21 steps have individual airborne/clearance/travel evidence. Zero applied body/generalized external forces, zero mocap bodies, and zero equality constraints. This is one deterministic flat-ground trial, not a robustness claim.
- **7 native tests passed:** no hidden root support, standing, alternating walking, missing-actor clock barrier, fresh ownership batch per step, finish-and-hold, and tick bounds.
- **18 Bun tests passed**, including owned physics plans, malformed/safety refusals, sequencing/idempotency, and the regression that the world engine cannot invent combined root translation.
- **3 pure admission checks passed**. The existing **4 launcher checks** cover child environment and Bun pin hygiene. Dedicated TypeScript checking passed.
- **Real Terse restart probe passed:** all four records, docking receipts, and owned physics authorizations survived a full runtime stop/start; all four activation IDs changed. The UI world/physics state is still not durably resumed.
- **Browser integration:** real four-actor coordination completed 6 physical steps and about 0.58 m travel, with maximum tilt about 5.6°. All four actors had saved 6 physics plans. Pause froze the native tick and root pose. Finish-and-hold reached standing with both feet in contact. Separation shut down the worker, preserved all four identities and physics-plan counters, and resumed independent numeric waypoint planning.
- Desktop **1440 × 1100** and mobile **390 × 844** had no horizontal overflow. The connected browser pass reported **0 errors and 0 warnings**. The final display-only adjustment changes completed arm/leg statuses to `holding`; those screenshots precede that text-only correction.

Local, ignored evidence:

- `.cache/world/evidence/mujoco-native-80s.jsonl`
- `.cache/world/evidence/tighter-combined.png`
- `.cache/world/evidence/mujoco-desktop.png`
- `.cache/world/evidence/mujoco-mobile.png`

The native long trial uses the local numeric policy directly. The browser trial separately exercises the real four-actor authorization path. Do not conflate those two tests.

## Faster physical gait

The live worker now starts with **Brisk**. Its weight-shift trajectory takes 1.5 seconds instead of Cautious's 2 seconds. Swing remains 1.4 seconds and the minimum landing interval remains 0.2 seconds. The actual support gate can extend a shift; the 8 stable samples, COM/velocity/contact thresholds, airborne/clearance/travel receipts, force limits and 500 Hz integration are unchanged. The four actors still own limb intents; changing trajectory timing does not turn them into separate joint-level controllers.

A paired comparison ran both profiles for 80 simulated walking seconds after 1.5 seconds settling, at three initial conditions: zero initial velocity and seeds 1 and 2 with planar initial velocity sampled within ±0.02 m/s before the first integration. These are limited flat-ground checks, not recovery or general robustness evidence.

| Profile | Steps in each run | Mean steady speed | Maximum tilt across runs |
| --- | --- | --- | --- |
| Cautious | 21 | 2.983 cm/s | 5.603° |
| Brisk | 25 | 3.511 cm/s | 5.491° |

Mean steady speed improved **17.7%**. It is a least-squares fit of measured root-forward displacement against simulation time at confirmed touchdowns, excluding the first two steps. All six runs completed without failure; all 138 counted steps retain individual receipts, with minimum sole-center clearance above 3.1 cm. Applied external forces remain zero. In the unperturbed pair, forward travel increased from 2.323 m to 2.773 m. This comparison uses the numeric baseline directly, not Terse wall-clock throughput.

The candidate search also recorded failures: 1.0/0.75/0.12-second shift/swing/landing timings fell; 1.6/1.1/0.16 missed the landing gate; a 1.0-second shift with the original swing fell. A 1.8/1.25/0.12 candidate stayed upright but was slower in measured travel. A 1.3-second shift also completed the unperturbed trial; the default retains the less aggressive 1.5-second shift. Failed candidates were not shipped, and no safety thresholds were loosened to make them pass.

Evidence is in `.cache/world/evidence/gait-comparison-80s.jsonl`, alongside the six candidate packets. `--compare-gaits --seconds 80` reproduces the serial paired comparison through the bounded runner. **11 native tests and 3 admission tests passed** after tuning. Native regressions cover faster measured speed, identical mechanics, six separate four-owner batches with alternating arm targets, finish-and-hold, and the real worker's Brisk default/authorization barrier. No TypeScript actor contract or city/gripper code changed for this tuning. A new real-Terse/browser speed measurement remains separate from this native comparison.

## Running and safety

The repo-local `.venv` now has pinned binary wheels from `physics/requirements.txt`: MuJoCo 3.17.0 and NumPy 2.5.4, with pinned transitive dependencies. No Playground/JAX, GPU, training, or global install was used. MuJoCo's [forward-dynamics and actuator model](https://mujoco.readthedocs.io/en/latest/computation.html) is the physics basis; live root coordinates are initialized only at reset and thereafter advanced by `mj_step`. IK may reposition scratch data, never the live free body.

The shared-host slot permits one native CPU trial at a time, each capped at five minutes, with **load1 < 100**, **swap ≤ 10 GiB**, and a stop if the host stalls. The original load limit of 30 was explicitly superseded by Myra. `run_bounded.py` checks admission before starting its child and every five seconds during longer trials. The browser worker uses the same gate and a five-minute lifetime. Use a separate process-list check before each round as well.

Example, from the repo root with a concrete Python executable:

```bash
env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  /absolute/path/to/python3.12 -I -B physics/run_bounded.py --test
```

For dependency installation, first obtain an admitted gate and use the same explicit isolated environment, additionally setting `PIP_CONFIG_FILE=/dev/null`; run the repo-local Python's pip with `--isolated --only-binary=:all: --keyring-provider disabled`, the public PyPI index, and the pinned requirements. No credential store is inspected. This is environment isolation, not an OS sandbox. The runtime worker does not make network calls; actor RPC stays on the selected local Terse endpoint.

An initial installer command incorrectly continued after printing an over-limit load. Its owned process was terminated; a later admitted, forced binary-wheel reinstall repaired the venv before any physics trial. Early walking attempts then correctly refused the contact gate: actual fist/thigh self-collision was blocking hip motion. Adjusting mechanical clearance, rather than suppressing those contacts, enabled the measured walk. These failures are not included as successful evidence.

## Remaining work

Conor clarified that physics must govern the whole mechanism, not just a separate walking mode. The next acceptance bar is specified in `CONTINUOUS-DESIGN.md`.

- One consistent physical model across independent Ranger locomotion, transformation, docking, combined movement, and separation.
- Art-quality skins attached to that physical skeleton; the current physics view deliberately shows the simpler collider rig.
- Turning, terrain, obstacles, perturbation recovery, and varied initial conditions.
- Full physics checkpoint/recovery and eventual Inkwell/Relay transport or model-directed goals.

Assembly remains visual, physics entry initializes a separate episode, and separation returns to the visual rails. No successful physical docking or whole-world crash recovery is claimed.
