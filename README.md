# Power Rangers

## Independent physical Ranger bench

The next robotics milestone is an independent humanoid that walks and picks up objects through actuated gripper contact. A **headless one-Ranger proof now walks, grasps a free box, lifts it from a visible waist-high stand, and carries it for two steps**. It is not yet the four-builder browser mode or connected to a durable job actor. Physical stacking and floor pickup remain future work. See [the measured result and run instructions](physics/RANGER-STATUS.md).

## New: four-Ranger assembly world

A separate, lightweight Three.js world now sits alongside David's original Go1 motion lab. Four complete, articulated Ranger-style robots work and roam around a plaza in a procedural city, rendezvous, and visibly fold into a Megazord's four limbs. The shared torso and head are passive geometry, **not a fifth actor**. The same four actor identities survive assembly and separation.

```bash
bun install --frozen-lockfile --ignore-scripts
(cd actors && bun install --frozen-lockfile --ignore-scripts)
python3 -I -B run_world.py --bun "$HOME/.bun/bin/bun"
```

Open **http://127.0.0.1:8771**. The visual world needs Bun 1.4.2+ and Python 3.12+, but not Playground, JAX, uv, API keys, or a hosted Terse account. **Walk in MuJoCo** additionally needs the repo-local physics dependencies below. The original motion lab remains separate and unchanged. Use `--port` and `--actor-port` to choose other unused loopback ports. Ctrl-C stops the world and its owned workers.

- **Ember / Cobalt** become the left / right arms; **Sol / Jade** become the left / right legs.
- Each real local `WorldRanger` Terse actor persists its own hardware slot, random seed, ordered decision record, waypoint, decision count, and docking receipt. A single world writer executes bounded movement and waits for all four receipts before assembly.
- **Assemble team** recalls the Rangers. Watch their original meshes fold and move on magnetic assembly rails; no replacement giant robot is substituted.
- **Walk in MuJoCo**, **Finish & hold**, **Separate team**, **Pause**, orbit/zoom, camera presets, and clickable Ranger cards are available. The live activity feed reports actual planner, assembly, and physical step events.
- The launcher gives Bun an explicit environment and an isolated HOME. Terse's pinned local-runtime installer may download its checksummed native runtime on first launch. New actor data is under ignored `.cache/world/actors-<actor-port>/` so separate local previews do not share an active database directory; older previews used `.cache/world/actors/`. The download cache is inside `.cache/world/home/`. There is no host sandbox claim.

### Joint-driven combined walking

The original procedural model now has tighter shoulders, hips, and neck, with visible docking collars. After assembly, **Walk in MuJoCo** enters an explicitly labeled, simplified physical rig. That view renders actual MuJoCo geometry poses: a free-root biped with 12 leg joints and 4 arm joints, gravity, ground contact, torque-limited servos, and non-adjacent self-contact. The old scripted combined root path has been removed.

The same four Terse actors persist a fresh owned-limb plan before each step: two arm-balance targets, one stepping leg, and one supporting leg. A shared numeric IK/contact controller executes those bounded intents at 100 Hz; the physics integrator runs at 500 Hz. The simulation clock waits while all four authorizations arrive. This is distributed intent ownership with shared low-level balance—not four independent torque-level brains.

Each counted step requires measured airborne time, more than 2 cm sole-center clearance, forward foot travel, and renewed ground contact. **Finish & hold** completes the current step; **Pause** freezes at a control-batch boundary. The straight-walk demo stops requesting steps after 2.5 m forward travel and has a five-minute worker lifetime. It is not a turning/navigation policy yet.

New native runs use the **Brisk** gait: a 1.5-second weight-shift trajectory instead of 2 seconds, with the original 1.4-second swing, landing checks, motor limits and physics clock unchanged. In three matched 80-second flat-ground trials, mean steady speed improved from **2.98 to 3.51 cm/s** (about **18%**), with no falls. These are small initial-condition variations, not arbitrary-terrain evidence. The previous **Cautious** profile remains available to the headless runner with `--gait cautious`. If this backend is already running, **Separate team → Assemble team → Walk in MuJoCo** creates a fresh worker using the updated gait; an existing worker keeps its original code.

On the shared development Mac, the current permission gate is load1 < 100 and swap ≤ 10 GiB; CPU trials are serial, capped at five minutes, and stop if the host stalls. After an admitted process/headroom check, install only local binary wheels:

```bash
python3 -I -B -m venv .venv
.venv/bin/python -I -B -m pip --isolated --disable-pip-version-check install \
  --only-binary=:all: --keyring-provider disabled -r physics/requirements.txt
```

For agent-run installation, use the explicit isolated environment in `physics/STATUS.md`, not the interactive shell's environment. Restart the world server after installation or a backend update. An older running server can still display the tighter visual model, but cannot provide the new MuJoCo action until restarted.

### City and job site (kinematic preview)

The world sits in a procedural city, with one chase camera per Ranger while they are apart and a single camera once combined. While split, four builders put up a 3×3×3 stack of crates on a slab north of the plaza, then carry two long beams in pairs. **Frame team** and **Assembly view** switch to a free orbit camera, and **Chase** switches back.

Each `WorldRanger` chooses its own next job (`decideBuild`), saves that claim, and saves a receipt per slot (`confirmPlaced`). The world starts no work on a slot until the claim is saved, and a beam does not lift until both carriers are in place. Crate colours show who placed what.

**This is not physical construction.** Walking, lifting and placing are timed animation, and crates are not simulated objects. Every receipt it writes says `evidence: "kinematic"`, which is not proof of a placement; physical work has a separate path (`authorizeDelivery` and `recordPlacement`) that accepts only measured receipts, and the live adapter that writes them is still in progress. Building stops during assembly, in combined form and in the MuJoCo rig, and picks up again afterward. Like other world state, the structure is in memory and does not survive a launcher restart, though the actors' records do.

### What this prototype does—and does not—prove

**Independent roaming, transformation, docking, and separation in this browser world are still kinematic.** Combined walking is now real MuJoCo locomotion on a simplified flat-ground biped rig, not yet the exact decorative Ranger meshes converted into one continuous physical mechanism. Entering that rig initializes a separate physics episode; leaving it returns to the visual assembly rails. Autonomous physical docking, terrain navigation, learned control, and integrating the independent Ranger bench into this world remain future work. The planners are numeric; there are **no model calls**. Coordination uses the local world barrier and Terse RPC, not Inkwell or Agent Relay.

Actor records are durable, but world poses, simulation time, and the last 120 log events are in application memory. A launcher restart deliberately creates a new episode with four new actor IDs; it does **not** resume the physical world. An uncertain actor outcome freezes the world rather than guessing or retrying a possibly committed decision. The untouched original Go1 lane below has a separate, more complete physics-checkpoint design.

Bounded checks for this new mode (do not run concurrently with the simulator):

```bash
bun --no-env-file test actors/world.test.ts actors/world-city.test.ts
bun --no-env-file actors/node_modules/typescript/bin/tsc -p actors/tsconfig.world.json
python3 -I -B tests/test_world_launcher.py
python3 -I -B tests/test_physics_admission.py
python3 -I -B physics/run_bounded.py --test
```

The actor unit tests use a mock SDK and do not prove persistence. Live browser, native walking, and real-runtime restart evidence is documented in `physics/STATUS.md`; the original visual-only packet remains in `world/VALIDATION.md`.

---

## Original Go1 motion lab

Four AI actors control one MuJoCo Go1 through shared local Terse state. Each Ranger owns one leg's timing and foot-placement policy. The demo shows their proposals, peer review, measured trials, and overlapping movement.

## Run the demo

```bash
uv sync
uv run rangers setup
# Install Bun, then install the pinned local Terse dependencies:
cd actors
bun install
cd ..
python3 scripts/set_openai_key.py
uv run rangers serve
```

Open **http://127.0.0.1:8765** and select **Run demo**. Existing `.env` files with `OPENAI_API_KEY` work automatically. The default model is `gpt-6-astra` with low reasoning effort. A demo usually makes 12 model calls; the bounded negotiation allows at most 16. It uses the configured API credits.

The page contains one demonstration: the robot, four Ranger decisions, a shared timeline, movement measurements, and durable recovery controls. Manual joint calibration, fixed gaits and tuning experiments are available as headless commands rather than competing dashboard modes.

- **Run demo:** negotiate and validate, then execute ten simulation seconds.
- **Pause / Continue:** freeze and resume the simulation clock, retaining independent leg phases.
- **Stop:** end this demo at its current pose.
- **Restart actors:** restart local Terse and verify identical physics/controller state and preserved Ranger decisions.
- **Resume saved:** reload the latest durable episode, including a partially completed negotiation. A stopped/completed episode remains stopped/completed.

The API key stays in the Python host. It is never passed to the browser or Terse processes, included in model prompts, or written to actor records. `.env`, databases and runtime artifacts are ignored by Git. No hosted Terse account is required.

## What the actors decide

There are four durable `TeamRanger` instances and one `TeamBody`.

Each Ranger has its own persisted model context and can change only its own leg's:

- Phase offset on the common 480 ms cycle.
- Swing duration and foot clearance.
- Forward/lateral foot-placement bias and velocity-feedback gain.

Four model requests run concurrently. The first pass drafts independent proposals. The next pass includes all four peer proposals. Two six-second MuJoCo trials return actual speed, posture, contact timing and failure measurements. A further pass lets each Ranger refine its own policy using that feedback. The Body stores the resulting agreement and rejects out-of-range or unstable plans; it never substitutes a fixed gait or rewrites a leg's decision.

The starting policy is the measured four-beat policy from the earlier gait search. Retaining a parameter is allowed; the UI displays the actual model decision and explanation. Trial validation currently requires healthy posture and forward speed above 0.08 m/s on both small initial-velocity perturbations. This does not establish robustness to terrain or large disturbances.

## Concurrent execution

**There is no group landing barrier, prescribed next pair, or minimum-contact-foot rule in this demo.** Each leg follows its own simulated start times and durations, including overlaps and possible flight. A late touchdown is recorded against that leg's deadline; it does not shift the other clocks. The common cycle gives the Rangers a shared time reference without imposing a sequential schedule.

Once accepted, the four policies repeat for the ten-second run. Models are called during planning and trial refinement, not during each joint-control tick. This milestone does not continuously renegotiate policies while the live robot moves. A shared numerical centroidal MPC handles body balance every 40 ms, and leg IK runs every 20 ms. The underlying native MuJoCo physics step is 4 ms. Stock masses, force limits and actuator gains remain unchanged; the support fixture and external body forces are off.

Each liftoff computes its target from the current COM, nominal leg geometry, measured velocity and that Ranger's placement parameters. Actual contacts are measured separately from planned timing. Flights are permitted, but this demo is not a validated galloping controller.

The Body commits native physics, MPC force history, foot trajectories, independent clocks and contact/deadline records every 100 simulation ms. Recovery can replay the last uncommitted window. A model response is saved to its Ranger before publishing the shared proposal; a crash before that save can repeat that API request. Exact replay requires the same model assets and dependency versions.

Local demo state lives in `artifacts/demo-state/`. Keep that directory to retain the episode. Only one worker should own an episode at a time.

## Headless run and verification

```bash
uv run rangers team --seconds 10 --restart-at 100
uv run pytest -q
RANGERS_INTEGRATION=1 uv run pytest tests/test_team.py tests/test_actors.py -q
```

`team` writes its observations, actual per-leg events, all model proposals, validation measurements and recovery results to `artifacts/team-demo.json`. Its separate database defaults to `artifacts/team-run-state/`.

Tests check parallel model dispatch, per-leg ownership, distinct swing durations, unrestricted overlap, continued motion after a missed touchdown, exact checkpoint continuation, duplicate request handling and real Terse restart recovery. API calls are replaced with explicit test doubles in automated tests; the demo has no scripted-model fallback.

The earlier fixed/reactive/paired controllers and centralized gait search remain available through `rangers actors`, `rangers evaluate`, `rangers gait-search`, and `rangers gait-replay`. See [historical experiment notes](docs/development-history.md) and [gait-search measurements](experiments/gait-search-results.json).

## Code

- `team.py`: independent model requests, peer review, measured refinement and durable execution sessions.
- `team_robot.py`: per-leg periodic policies, action clocks, telemetry and full controller checkpoints.
- `gallop.py`: numerical MPC/IK executor and contact-based evaluation.
- `actors/src/actor.ts`: durable Rangers, shared Body and prior experiment actors.
- `actors/src/team-contract.ts`: per-leg parameter validation; no pair-selection rule.
- `server.py` / `dashboard.html`: the focused local demo; physics and rendering stay on the main thread.

The robot assets come from MuJoCo Playground 0.2.0 and its pinned [MuJoCo Menagerie Go1](https://github.com/google-deepmind/mujoco_menagerie/tree/1b86ece576591213e2b666ebf59508454200ca97/unitree_go1). Original assets and licenses remain in `.cache/go1/`. Actors use the official local Terse runtime, pinned by `actors/bun.lock`. Model requests use the official [OpenAI Responses function-calling API](https://developers.openai.com/api/docs/guides/function-calling).
