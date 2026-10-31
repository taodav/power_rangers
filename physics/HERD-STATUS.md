# V3: four physical Rangers, one shared world

This branch starts at the one-Ranger physical-builder baseline. It does not change the stable integrated demo branch.

## Implemented foundation

- One authoritative MuJoCo `MjModel` and `MjData`, containing four independent free-root humanoids, four free boxes, eight visible stands and one floor.
- Four independent numeric controllers, with 28 finite-force actuators each (112 total). Names and root indices are scoped to a hardware owner. Controllers cannot advance or reset the shared physics individually.
- One 100 Hz control clock and one 500 Hz integration loop. All robot/object contacts are resolved in the same simulation. A controller writing another robot's actuators stops the round before integration.
- Four real local Terse `HerdRanger` actors. Each owns one hardware slot, cargo and destination, saves its own intent and later validates its own measured placement receipt.
- A four-actor start barrier: all four durable authorizations must succeed before any delivery begins. Partial authorizations are not silently rolled back or replayed; explicit Stop reconciles this episode's active intents.
- Completion requires native release/settling evidence and the corresponding actor's saved measured receipt. The entire physical episode stops on any unsafe or uncertain result.

## Measured evidence

The real local Terse + native probe completed all four deliveries in **39 simulated seconds**, with **4 verified footsteps per Ranger**, four measured placements and four independently saved receipts. After the native worker stopped, the complete Terse runtime stopped and restarted against the same data directory. All four receipts were unchanged and all four actors had fresh activation IDs.

This verifies **receipt persistence**, not recovery of an interrupted physics world. The probe explicitly reports `physicsResumeVerified: false`.

Ignored local evidence:

- `.cache/world/evidence/herd-live-probe.txt`
- `.cache/world/evidence/herd-live-receipts.json`
- `.cache/world/evidence/v3-herd-tests-final.txt`
- `.cache/world/evidence/v3-ranger-regressions.txt`
- `.cache/world/evidence/v3-biped-regressions.txt`

Focused verification includes 82 Bun tests, 9 original Ranger regressions, 11 biped regressions, 6 admission controls and 4 launcher controls. The shared-world suite checks the single clock/model/data, disjoint actuator ownership, rejection of controller-local reset/step, cross-robot collision contacts in an initial-condition control, atomic job admission and four complete measured deliveries. TypeScript includes the actor, adapter, API and real-runtime probe.

## What this does not prove

The four workspaces are separated and use the existing fixed delivery skill. These are simultaneous independent deliveries with shared physics and a shared start barrier—not task negotiation, obstacle avoidance, shared stacking or cooperative beam carrying. Actors authorize bounded numeric jobs; there are no model calls and no four-way torque-level negotiation.

There are no grasp welds, mocap bodies, gravity compensation, live root/object pose writes or external support forces. The overlap collision control is an initial-condition fixture, not a successful collision-recovery trial. The decorative city is not imported as collision geometry.

A launcher restart creates a new episode and actor IDs. Physics, controller state and object state are not checkpointed. No autonomous docking, physical combination, arbitrary grasping or floor pickup is claimed.

## Separate API contract

Launch with `python3 -I -B run_herd.py --bun /absolute/path/to/bun`. Defaults are HTTP **8775** and local Terse **7116**, separate from the stable demo.

The API server and launcher are source/typechecked; their HTTP acceptance run is still pending. The root page is deliberately an **API-only notice**, not a finished UI. Wren's display integration is separate.

- `GET /api/state`: `{run, rangers, actorIds, herd, events, error, paused, inflight, control, boundary}`.
- `herd` is null when idle; otherwise `{status, owners, physics, error}`.
- `owners`: four `{slot, actorId, jobId, record}` entries. Each `record` is that actor's durable delivery record.
- `physics`: one authoritative `{tick, time, physics_time, failed, authorized, complete, rangers, objects, actuator_owners, geoms, actor_bindings, boundary}` snapshot. `rangers` has the existing per-Ranger native shape, including measured body/hand/contact/receipt data. `geoms` covers the entire shared world once.
- Native `actor_bindings` is null. The adapter's `owners` envelope provides the actual durable binding; the simulator itself does not call Terse.
- Same-origin `POST /api/command` with JSON `{command: "herd-deliver"}`, `herd-stop` or `pause`.
- Pause freezes the single shared clock. Stop terminates the episode and reconciles only its unfinished intents, preserving completed receipts. Completed poses are retained until Stop; their worker has ended.

## Bounded validation

Obtain the serial host slot and check processes before every round. Conor's previews take priority. The optional `--yield-to-previews` flag checks the known local demo endpoints and stops the owned round if a user enters native motion. A retained pose with a latched world error or a completed builder is not classified as running motion. Uninterpretable responses refuse admission.

```bash
env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  "$PWD/.venv/bin/python" -I -B physics/run_bounded.py --herd --test --yield-to-previews

env -i HOME="$PWD/.cache/world/home" TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 RANGERS_WORLD_ACTOR_PORT=7116 \
  /absolute/path/to/bun --no-env-file actors/herd-probe.ts
```

The probe requires isolated HOME/TMPDIR, an explicit environment and a free port. It starts four actors, one bounded native worker, then performs a receipt-only runtime restart. It writes evidence only under ignored `.cache/world/`. The SDK may download its pinned local runtime into the isolated cache. This is environment isolation, not host or network sandboxing.
