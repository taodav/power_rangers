# Independent physical Ranger: pickup and carry

Measured October 31, 2026. This is a **headless, one-robot manipulation bench**, not yet the four-builder browser mode. It reuses the validated free-body leg controller, with a separate independent humanoid model and physical grippers. The combined demo is preserved.

## What physically happened

One Ranger took two approach steps, reached above a visible pickup stand, lowered an open parallel-jaw gripper around a free box, closed its fingers, lifted the box, and took two more steps while carrying it. The robot and the box retain their original free joints throughout; nothing is attached through a weld, pose write, or animation.

- Payload: a 10 cm cube, mass 0.12 kg, initially supported on a 94 cm-high stand.
- Model: two six-joint legs, two six-joint arms, and two separately actuated fingers per hand: 28 finite-force actuators. The demonstrated grasp uses the right hand.
- Final trial: **4 contact-verified steps**, **0.368 m robot travel**, **0.149 m maximum box lift**, and **0.179 m box travel during the carrying phase**.
- Maximum torso tilt: **5.397 degrees**. Both finger contacts persisted while carrying and during the final one-second hold; the box had no ground or stand support.
- No mocap bodies, equality constraints, body gravity compensation, actuated root, or applied external body/generalized forces.

The reference run is `.cache/world/evidence/ranger-physical-pickup.jsonl`. The first attempts are retained locally as `ranger-candidate*.jsonl`: one exposed a method-name collision; others refused unreachable poses or collided with the stand. Wrist clearance, a full six-joint arm, an overhead approach, and a narrower stand outside the leg path resolved those cases. Contact exclusions were not added to hide those failures.

## Verification and limits

**6 Ranger tests, 11 existing biped tests, and 3 admission tests passed.** Counterfactual checks disable the jaw motors or remove finger/box friction: both fail to produce an unsupported-lift receipt. This demonstrates dependence on physical gripping rather than an attachment shortcut in those tested cases.

The trial is deterministic, on flat ground, with one light, prepositioned box. It does not establish floor pickup, arbitrary object grasping, obstacle navigation, stacking, four-robot interaction, durability of physics state, or recovery from disturbances. The stand is deliberately visible. No placement has been implemented or claimed.

No Terse actor is bound to this bench yet; `actor_binding` is explicitly `null`. Its job sequencer and low-level controllers are numeric. The four-actor browser mode remains a separate implementation, including its disclosed kinematic independent roaming and assembly.

## Integration contract

- `objects[]` exposes object ID, measured position/quaternion, mass, current support, and `held_by`.
- `held_by` is non-null only after a sustained lift has been measured and the current frame still has both finger contacts, normal force above 0.3 N at each finger, no floor/stand support, and no failure.
- `manipulation_receipts` reports `finger_contact`, `unsupported_lift`, and `carry`, with simulation time, object ID and owner slot. These are in-memory physical observations, not durable actor commits.
- `placed` is always false for now. A future placement receipt must require released fingers, measured support, target-pose tolerance, and a settling interval. A durable claim alone must never produce it.

Next: bind an independent Ranger's durable job intents to these measured outcomes; add physical placement; then put four independently controlled copies in one MuJoCo world. Wren's job-site UI can consume measured object and hand poses rather than its current display-only motion.

## Reproduce

Stop other native previews and obtain the shared-host validation slot first. Use the same process, load, swap and five-minute guards as the combined gait tests. From the repo root:

```bash
env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  "$PWD/.venv/bin/python" -I -B physics/run_bounded.py --ranger --seconds 40

env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  "$PWD/.venv/bin/python" -I -B physics/run_bounded.py --ranger --test
```

The runner advances one native CPU trial at a time. It does not launch a browser or change a running world server.
