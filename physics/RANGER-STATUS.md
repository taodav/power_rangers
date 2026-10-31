# Independent physical Ranger: pickup, carry and placement

Measured October 31, 2026. One independent humanoid now completes a contact-driven delivery, with a real local Terse actor authorizing the job and saving its measured placement receipt. It reuses the free-body leg controller with a separate humanoid model and physical grippers. The combined demo and original Go1 lab remain separate.

## What physically happened

The Ranger takes two approach steps, reaches above a visible pickup stand, lowers an open parallel-jaw gripper around a free box, closes its fingers, lifts the box, and takes two carrying steps. It then places the box on the destination stand, opens its fingers, withdraws its hand and checks that the released box settles. Robot and box retain their original free joints throughout: no weld, animation, live pose writes or invisible support.

- Payload: a 10 cm cube, mass 0.12 kg, initially supported on a visible 94 cm-high stand.
- Robot: two six-joint legs, two six-joint arms and two separately actuated fingers per hand: 28 finite-force actuators. The demonstrated grasp uses the right hand.
- Full live delivery: **4 contact-verified steps**, approximately **0.427 m forward travel**, **0.149 m maximum box lift**, maximum torso tilt **5.397 degrees**.
- Placement receipt at **38.95 simulated seconds**, after 50 consecutive 100 Hz samples meeting the release/settle checks. The live adapter stops the worker at the following five-tick batch boundary (39 seconds).
- Box center approximately **[0.928707, 0.829846, 0.989991] m**, against target **[0.93, 0.83, 0.99] m**: about 1.3 mm position error.
- Measured destination support **1.1772 N**; no robot contact; both fingers open; linear speed below 0.02 m/s; tilt below 8 degrees. The actual final speed was near numerical zero.
- No mocap bodies, equality constraints, gravity compensation, actuated root or applied external body/generalized forces.

Ignored local evidence: `.cache/world/evidence/ranger-place-candidate1.jsonl`, `ranger-place-tests.txt`, `live-builder-probe.txt` and `live-builder-receipt.json`. These are measurements from the deterministic fixed bench, not arbitrary-terrain or disturbance robustness evidence.

## Durable ownership and live controls

`deliver` accepts only `cargo-0` to `station-1`. After draining existing actor calls, it suspends the kinematic city preview and settles a separate native Ranger. Ember (slot 0) then saves `authorizeDelivery` intent; only that acknowledgement permits the native job to start. This is a fixed numeric delivery skill, not a model generating new joint trajectories.

The server exposes an additive `state.builder` envelope containing the actor ID, job ID, status, native `physics` snapshot and independently saved `actorRecord`. Native geometry, box and hand poses come from MuJoCo. The raw native snapshot retains `actor_binding: null`: binding is the adapter's responsibility, represented by the outer envelope.

The adapter checks the measured placement receipt, then calls `confirmDelivery`. The actor independently checks matching job, hardware owner, object, destination, released fingers, no robot contact, support force, speed, tilt, settling samples and target tolerances. A claim, timer or kinematic receipt cannot count as physical placement. A failed or uncertain authorization/confirmation stops the native worker without automatically replaying motion or persistence calls.

- **Pause** freezes the physics clock at a control-batch boundary; resume continues the same job.
- Mode changes and duplicate deliveries refuse while a builder episode exists.
- **Stop builder** terminates the episode and cancels only unfinished intent; a completed receipt is preserved. It returns to the explicitly kinematic city preview, not a continuous physical world.
- A completed view retains the last measured pose; its native worker has stopped.

The first live API acceptance run passed authorization-before-motion, pause/frozen tick, conflicting-command refusals, full physical delivery and an acknowledged Terse placement receipt. The adapter unit tests use fake workers/RPC; they do not establish physics or durability themselves.

## Verification and remaining limits

**9 native Ranger tests passed**, including full delivery, free-body/finite-force structure, fixed-job protocol, target-pose-without-support rejection and disabled-jaw / frictionless negative controls. Both grip counterfactuals fail to produce an unsupported-lift receipt. **77 focused Bun tests and the dedicated TypeScript check passed** across the world, city preview, durable delivery rules and native adapter.

This is **one physical robot and one active delivery actor**, within the existing four-actor application. The other three do not coordinate this delivery yet. The city construction preview is still kinematic. No floor pickup, stacking, arbitrary grasp, obstacle navigation, two-robot beam carrying or physical combination is claimed.

Actor intent and receipts persist, but physics/controller/object state is in memory. A launcher restart creates a new episode and new actor IDs; it does not recover an interrupted carry. The existing real-runtime restart probe uses synthetic delivery receipts to test record persistence, not physical motion. Full physics checkpoint/recovery and four independently controlled robots in one MuJoCo world are the next milestones.

## Reproduce

Stop other native previews and obtain the shared-host validation slot first. Use the same process, load, swap and five-minute guards as the combined gait tests. From the repo root:

```bash
env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  "$PWD/.venv/bin/python" -I -B physics/run_bounded.py --ranger --deliver --seconds 55

env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  "$PWD/.venv/bin/python" -I -B physics/run_bounded.py --ranger --test
```

Omit `--deliver` for the earlier pickup-and-carry-only bench. Start the browser application with `run_world.py` as in the README, after installing the repo-local physics requirements. Every native worker uses a closed model selection, explicit minimal environment, bounded input/output, command timeout, host load/swap gate and five-minute lifetime. No paid model calls, hosted Terse or global installs are needed.
