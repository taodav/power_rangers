# Development history

These are historical experiment notes. The old motion-lab dashboard has been replaced by the focused four-Ranger demo described in the root README. Headless experiment commands remain available; old UI instructions below are archival.

# Power Rangers · Motion Lab

Timed leg-motion experiments using MuJoCo Playground's Unitree Go1 model. Four independently controlled legs share one physics simulation and one integer simulation clock.

The current milestone adds a **Fast diagonal-pair profile**, measured at about 10.2 cm/s on flat ground. Front-right + rear-left swing together, followed by front-left + rear-right. Four Ranger actors share velocity goals, paired reservations, landing barriers and durable checkpoints. The previous Brisk paired gait, single-leg reactive motion and original scripted crawl remain available for comparison.

## Run locally

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/). From this directory:

```bash
uv sync
uv run rangers setup
uv run rangers serve
```

Open **http://127.0.0.1:8765**. The server binds to loopback only. On the first setup, five mesh files and their license are downloaded from a pinned official MuJoCo Menagerie revision; subsequent runs work offline.

1. Choose a colored leg and a motion.
2. Set duration, displacement, and foot clearance.
3. Click **Arm motion**, then **Run simulation** or **Advance 100 ms**.
4. Watch the leg's phase, contact state, planned remaining time, and actual completion event.
5. Arm a second leg with a different duration to observe independent completion.
6. **Save state** during a motion, advance, then **Restore** to resume from the saved tick. This dashboard checkpoint is in memory and lasts until the server exits.

Simulation starts paused. Arming does not advance time. A 100 ms advance runs five 20 ms control ticks, each containing five 4 ms physics steps. Pausing freezes motion progress. Rendering or network delays only slow wall-clock execution; they do not skip simulation ticks.

### Scripted crawl

Click **Run crawl** to reset into free-body mode and execute 1, 3, or 6 cycles. The rig is disabled automatically. The body moves using joint actuators only; no external trunk forces or pose teleportation are used.

Each step shifts the center of mass inside the remaining three feet's support triangle, swings one foot forward, confirms touchdown, and transfers support. The sequence is rear left → front left → rear right → front right. Planned foot displacement is 5 cm. Each weight shift takes at least 1.2 s, each swing has a nominal 0.7 s duration, and touchdown settling takes at least 0.3 s. Contact and stability gates can extend these intervals; deadlines terminate failed attempts.

**Finish & stop** completes an in-flight swing and recenters on all four feet. **Pause** freezes simulation time immediately. At normal completion, the body recenters and playback pauses. **Reset** returns to manual leg mode. Manual commands are disabled while the crawl controller owns the body.

The green outline joins feet currently in contact; the orange marker projects the whole-robot center of mass onto the ground. The dashboard shows phase, actual foot placements, forward displacement, torso tilt, and signed support margin. A positive margin means the projection is inside the contact polygon; it is a geometric measure, not a guarantee of dynamic stability.

The stance controller distributes a desired body wrench across the supporting feet using nonnegative forces in a friction pyramid. It maps these forces through foot Jacobians to joint torques, implemented as position-actuator target offsets. Swing feet use IK and the stock position servos. The **Run crawl** button is the centralized scripted baseline. **Run with actors** uses the same motion executor and stance controller, with leg decisions supplied by Terse actors. Neither mode makes model calls.

Headless validation:

```bash
uv run rangers crawl --cycles 6 --render artifacts/crawl.png
uv run rangers crawl --cycles 1 --backend mjx --output artifacts/crawl-mjx.json
```

The native baseline completed 6 cycles / 24 confirmed foot placements in 58.14 simulated seconds, with 36.8 cm net body travel and a maximum torso tilt of 2.06°. Displacement includes initial positioning and final recentering. MJX-JAX also completed a full cycle. These are flat-ground checks of this specific model, not a claim of robustness on arbitrary terrain.

### Local durable actors

**No hosted Terse account, login, or deployment is needed.** Requires Bun 1.4.2+ and the actor dependencies:

```bash
cd actors
bun install --frozen-lockfile
cd ..
uv run --offline rangers serve
```

On this hackathon machine, Bun and the dependencies are already installed. The Python launcher also recognizes the project-local Bun binary in `.cache/bun/bun-darwin-aarch64/`.

Click **Run with actors** in the dashboard. It starts the official Terse local runtime on loopback port 7100 automatically. The existing cycle selector applies to both modes as a budget of four placements per cycle. Reactive policies may choose a leg more than once within those four placements. The runtime uses a randomly generated local credential held in memory; no OpenAI or hosted Terse credentials are loaded or sent. Local actor databases and the latest episode pointer live in ignored `actors/.durable-actors/`. Keep that directory to retain episodes.

- **Ranger actors:** four instances, one per leg. Each persists its last decision and decision count. They read the same Body revision and independently return `wait` or `step`. The fixed policy follows the original crawl order. The reactive policy uses the shared velocity goal, body/foot observations, placement error, waiting age and the required support shift to bid for a step.
- **Body actor:** the shared durable arbiter. It checks observation revisions, motion limits and proposal validity windows. Single-leg modes reserve the highest-scoring eligible step. Diagonal mode atomically reserves both eligible partners with matching timing; one partner waiting means neither is reserved. The executor checks physical support before lift.
- **MuJoCo worker:** executes weight shifting, stance control, swing and contact detection. A reservation does not immediately lift a foot: the existing support gate still has to pass. The dashboard distinguishes requested intentions from actual execution events.

The worker prepares a versioned round, advances up to five 20 ms control ticks, then commits the complete checkpoint and timeline together. The round reservation is durable before physics advances. Decision calls and runtime recovery consume wall time only: simulation time stays frozen. Pausing flushes a partial round. Nominal swing duration, deadline, actual touchdown and remaining ticks all survive recovery.

Click **Restart actors** during a swing to stop the local runtime, start it again, and reload the Body checkpoint into the simulator. The dashboard verifies an identical checkpoint, new activations for all five actors, and preserved Ranger decisions. This leaves playback paused; click **Run simulation** to continue. A hard crash can delay recovery by roughly 30 seconds while Terse's previous-owner lease expires; retries leave simulation time frozen. **Resume saved** loads the latest episode paused after restarting the dashboard; click **Run simulation** to continue. If a connection fails, physics pauses and **Recover connection** reloads the authoritative checkpoint.

The worker may replay up to 100 ms of *uncommitted simulation* after an unexpected crash. A versioned prepare/commit protocol prevents duplicated committed actions; this is not an exactly-once guarantee for physical hardware. State is local to this machine, requires the same model/dependency versions, and currently supports native MuJoCo only. The actor API is intended for one simulation owner. Centralized numeric balance remains explicit; this is reactive distributed coordination using numeric rules, not learned multi-agent locomotion yet. Calls still use the paused simulation clock; asynchronous model planning is a later experiment.

Headless actor run with a hard restart during the first swing:

```bash
uv run --offline rangers actors --cycles 3 --restart-at 85 --port 0
```

The verified three-cycle actor run completed 12 placements in 29.70 simulated seconds, traveling 20.2 cm with a maximum tilt of 2.06°, including a hard restart at tick 85.

`--port 0` chooses a free port. The headless command uses a separate database in `artifacts/actor-run-state/` (override with `--data-dir`), so it can run alongside the dashboard without replacing its saved episode. Results, timeline, motion IDs and restart checks are saved to `artifacts/actors.json`.

### Simultaneous diagonal pairs

The dashboard now defaults to **Diagonal pairs → Fast**, with a **12 cm/s** forward goal. Click **Run with actors**. Choose **Brisk** to reproduce the earlier 5 cm/s goal. Forward, reverse, sideways, turn and hold presets work during a run. The pair status shows both active legs and accumulated time with both feet actually airborne; the timeline records their shared reservation and individual touchdowns.

The sequence is **FR + RL → FL + RR**. Each Ranger computes its own foothold from the shared body goal and physical observations. Both partners must propose compatible motions at the same Body revision. The Body persists the pair in one reservation; the executor starts both on exactly the same simulation tick after aligning the center of mass with the opposite diagonal. The supporting pair receives the body wrench through the existing joint actuators. This is a conservative, contact-gated paired gait with all-foot intervals, not a flight-phase running gait or a learned coordination policy. The diagonal phase arrangement follows the usual trot pattern (see the [MIT Cheetah controller](https://github.com/mit-biomimetics/Cheetah-Software/blob/master/user/MIT_Controller/Controllers/convexMPC/ConvexMPCLocomotion.cpp)); this implementation uses instantaneous wrench allocation, not that controller's predictive optimization.

Brisk swings have a planned duration of **0.24 s**, with 2.5 cm clearance. Initial support alignment takes at least 0.5 s; subsequent alignment takes at least 0.2 s, extended as needed by measured contact and center-of-mass position. Both feet must confirm touchdown before the next pair can begin. A failed partner terminates the pair. Hold or stop finishes both reserved landings before supporting on all four feet. A midair goal change leaves both existing targets intact. Both motion IDs, targets, progress, deadlines, and the next diagonal phase survive checkpoint recovery.

The UI reports **Diagonal stance** while two feet support the body: a two-foot line has no positive polygon margin. Brisk allows goals of ±8 cm/s forward, ±4 cm/s sideways and ±0.20 rad/s turning. Fast raises only the forward/reverse command limit to ±15 cm/s. These are input limits; achievable speed saturates near 5 cm/s for Brisk and 10–11 cm/s for Fast in the tested forward configurations. Single-leg mode keeps its previous smaller limits.

```bash
uv run --offline rangers actors --policy trot --profile brisk --vx .05 --cycles 6 --port 0
uv run --offline rangers evaluate --suite paired --seeds 5 --cycles 6
```

Five seeds per case, 24 placements, native physics on flat ground:

| Controller | Forward goal | Measured steady speed | Peak concurrent swings |
| --- | --- | --- | --- |
| Previous reactive single-leg default | 1.2 cm/s | 1.240 cm/s | 1 |
| Reactive single leg | 2.5 cm/s | 1.204 cm/s | 1 |
| Diagonal pairs | 2.5 cm/s | 2.550 cm/s | 2 |
| Diagonal pairs, new default | 5.0 cm/s | 4.852 cm/s | 2 |

The new default is **3.9×** the previous reactive default. At the same 2.5 cm/s command, paired mode is **2.1×** as fast. These compare complete gait configurations, including shorter swing/transfer timing, rather than isolating concurrency alone. Speeds use simulated time and the same steady-position slope definition below; they do not measure Terse wall-clock throughput.

All **50 paired-suite evaluation runs** completed without falls, including reverse, both sideways directions, both turns and a curved path. Maximum tilt was 6.06° across the suite (3.62° for fast forward). Each fast-forward run measured **2.64 s with both swinging feet simultaneously airborne**. Results are in `artifacts/paired-evaluation.json`; testing covers the flat floor and small initial velocity perturbations. No calibration weld or externally applied body forces are used.

### Fast profile

Fast keeps the same diagonal pairing and landing barriers. It uses a 0.20 s planned swing, 2 cm clearance, up to 13 cm foot displacement (14.5 cm executor validation bound), and a minimum 0.08 s support alignment after the initial 0.5 s alignment. Its all-foot transfer wait is 0.04 s. Contact confirmation and the 1.2 cm center-of-mass distance gate can extend these intervals; shortening a minimum never bypasses those checks. Stronger body-position feedback (100 versus 60) brings the body over the supporting diagonal sooner. The model's torque limits, control limits, masses, friction model, and simulation timestep are unchanged.

Profile limits and timing live in `src/power_rangers/gaits.json`, read by both the TypeScript actors and Python executor. Brisk retains its prior gains, smaller workspace and motion timings. Profile selection is fixed for an episode and saved with its checkpoint. Hold, stop and live goal changes still preserve both in-flight targets.

```bash
uv run --offline rangers actors --policy trot --profile fast --vx .12 --cycles 6 --port 0
uv run --offline rangers evaluate --suite speed --seeds 5 --cycles 12
```

Longer comparison: five seeds × 48 placements per case, same flat-ground perturbations and steady-body speed metric:

| Profile | Forward goal | Measured steady speed |
| --- | --- | --- |
| Brisk, previous default | 5 cm/s | 4.834 cm/s |
| Brisk | 8 cm/s | 4.548 cm/s |
| Fast | 8 cm/s | 7.968 cm/s |
| Fast, new default | 12 cm/s | 10.213 cm/s |
| Fast | 15 cm/s | 10.667 cm/s |

Fast is **2.1× faster** at its new default, and **1.75× faster** at the same 8 cm/s command. All **55 speed-suite runs** completed without falls, covering the comparisons above, reverse, both sideways directions, both turns, and a curved path. Maximum tilt among Fast runs was 2.71° (2.09° for its default forward goal). Reverse averaged −10.70 cm/s and sideways motion approximately ±4 cm/s. These are simulation-time locomotion speeds, not wall-clock playback or RPC throughput. The report `artifacts/speed-evaluation.json` also records time spent aligning, swinging and transferring support.

### Reactive single-leg velocity goals

Select **Reactive single leg** and **Brisk**, then **Run with actors**. Use the forward, reverse, sideways, turn or hold presets during a run, or adjust the sliders and click **Apply goal**. Forward/left velocities are in cm/s in the commanded body heading; positive turning is left. The currently accepted goal is shown separately from the sliders. A goal change preserves an in-flight foot target and takes effect in subsequent planning. A paused episode stays paused.

**Hold** is a zero-velocity goal: finish the reserved placement, then keep all feet supporting the body while simulation time continues. It does not end the episode or consume the placement budget. A new nonzero goal resumes stepping. **Finish & stop** ends the episode after a safe support transfer. Goals, motion targets, yaw interpolation, and reference-controller history all persist through restart.

Each reactive Ranger proposes a bounded world-space foothold toward a preview of the requested body pose. A bounded reference pose integrates the velocity goal and corrects drift. The actor ranks its placement error, the number of intervening placements, and the body shift needed to unload its foot. The numerical stance controller follows the foot formation's yaw gradually. Only one leg swings at a time. Footstep displacements are capped at 7 cm in the policy (8.5 cm validation bound); unreachable requested speeds therefore saturate. Goal tracking is approximate, particularly during starts, reversals and turns. The request limits are ±2.5 cm/s forward, ±1.5 cm/s sideways and ±0.08 rad/s yaw; these are command limits, not promised achieved speeds.

Baseline timing uses a 1.2 s minimum shift, 0.7 s planned swing, 3.5 cm clearance and 0.3 s settling. Brisk uses 0.6 s, 0.45 s, 2.5 cm and 0.16 s respectively. Both retain the same support-margin, contact-confirmation and actuator limits. Actual swings can take longer than planned while finding the ground.

```bash
uv run --offline rangers actors --policy reactive --profile brisk --vx .012 --cycles 6 --port 0
uv run --offline rangers actors --policy reactive --profile brisk --vx 0 --yaw-rate .04 --port 0
uv run --offline rangers evaluate --seeds 5 --cycles 6
```

The headless actor command has a finite execution budget; a zero-goal hold intentionally never completes its placement budget, so use the dashboard for an indefinite hold.

The evaluation runs the **same TypeScript policy functions** as the actors through a local policy worker, using native physics. It omits Terse RPC latency to isolate locomotion and saves every trial and metric definition to `artifacts/reactive-evaluation.json`. The `ordered` evaluation policy uses the same adaptive footholds as reactive mode but retains the original leg order, isolating the effect of choosing the next leg.

Measured steady forward speed, five seeds × 24 placements, initial base-velocity perturbation standard deviation 0.015:

| Policy | Timing | Mean body speed |
| --- | --- | --- |
| Original fixed 5 cm steps | Baseline | 0.588 cm/s |
| Original fixed 5 cm steps | Brisk | 0.911 cm/s |
| Adaptive footholds, fixed order | Brisk | 1.152 cm/s |
| Reactive footholds and order | Baseline | 0.749 cm/s |
| Reactive footholds and order | Brisk | 1.240 cm/s |

The full reactive/brisk setup is about **2.1×** the original baseline. Compared with adaptive footholds using the same brisk timing and fixed order, reactive selection improves measured speed by about **7.6%**. This separates timing/placement improvements from the coordination change. Speeds are slopes fitted to the actual body position after the first four placements and before the final touchdown, excluding startup and final recentering; these are simulation-time results, not wall-clock throughput.

All **55 evaluation runs** completed without a fall: the five forward comparisons plus reactive reverse, both sideways directions, both turns, and a curved path, each across five seeds. Maximum tilt was 2.09°. Pure turns produced approximately +80° / −82° over 24 placements. These checks use the flat floor and small initial perturbations only. `mechanical_work_j` integrates absolute joint mechanical power; it is not electrical energy consumption.

### Calibration and free-body modes

The default **calibration rig** uses an explicit MuJoCo weld constraint between the trunk and a mocap anchor. The visible vertical fixture and UI label identify this assistance. It lets us validate each foot trajectory while the torso is supported. This is not autonomous walking.

Uncheck the rig to reset into unassisted physics, or start with:

```bash
uv run rangers serve --free-body
```

The robot stands unassisted. Individual manual leg swings can destabilize it; the scripted crawl adds stance control and weight shifting to address this. A detected fall pauses the demo. We retain Playground's feet-only contact model, so torso-ground collision behavior is not realistic after falling.

### MJX

```bash
uv run rangers serve --backend mjx --port 8766
```

Both backends use the same Playground XML, position actuators, trajectory runner, and control timestep. The default uses native MuJoCo for an interactive single scene on a Mac. The optional backend executes the physics substeps through JIT-compiled MJX-JAX. It has an initial compilation cost. It still uses host-side IK and rendering and is not a fully vectorized training environment. MJX checkpoint restore is intentionally disabled until we implement serialization of its complete execution state.

## Motion contract

`Simulation.start(leg, primitive, duration, forward, clearance)` accepts one action per leg at a time. `Simulation.step(n)` advances all active motions concurrently. Names are `FR`, `FL`, `RR`, and `RL`.

| Primitive | Control | Completion |
| --- | --- | --- |
| `swing_to` | Smooth lift → horizontal travel → descent, followed by bounded ground search | Three consecutive contact ticks after liftoff during landing, or failure at the deadline |
| `support` | Track the starting world-space foot position with leg IK | Requested duration; reports sustained contact loss |
| `push` | Attempt a backward stroke along the starting body heading | Requested duration; reports sustained contact loss |

These are procedural controllers, not learned policies. `push` is a preliminary contact stroke, not a validated walking skill. In manual mode, idle legs hold their last joint targets. The scripted crawl uses its own stance controller and swing sequence.

All actions store an ID, start tick, quantized duration, deadline, starting and target foot positions, phase, liftoff/contact history, result, and actual end tick. Expected completion is separate from actual touchdown. The nominal 600 ms swing can take longer while searching for the ground. Parameter ranges are intentionally small; not every combination is guaranteed to complete.

`Simulation.checkpoint()` produces a JSON-serializable snapshot of native MuJoCo integration state, the motion runner, and the crawl controller (including its force-controller history, anchors, phase, and pending stop). `restore()` continues it with the same backend, model, and dependency versions. Tests cover two concurrent manual swings and a checkpoint mid-crawl. The local Terse Body actor persists this payload after each execution window. The experimental model-driven gait search below uses a separate executor.

## Experimental model-driven gait search

```bash
# Six model calls, three candidate policies per call, two short trials per policy.
uv run rangers gait-search --rounds 6

# Replay the selected policy locally, without another API call.
uv run rangers gait-replay artifacts/gait-search/best-policy.json \
  --seconds 10 --gif artifacts/gallop.gif
```

This is inference-driven policy optimization, not model-weight fine-tuning. An OpenAI model receives measured trial summaries and proposes bounded gait parameters through a strict `evaluate_gaits` function. MuJoCo executes each candidate and returns speed, falls, posture, torque saturation, actual contact order, and airtime. The default is `gpt-6-astra`, medium reasoning, with at most 6,000 output tokens per call. `--rounds` is the total number of rounds, including already completed rounds when resuming; `--model` selects another compatible Responses model. Calls use hackathon API credits.

The periodic executor removes the diagonal-pair landing barrier. It supports individual leg phases and uses a small centroidal MPC every 40 ms, plus leg IK every 20 ms. Swing and stance durations use simulation time, independent of API latency. The model chooses policy parameters between complete rollouts; it is not in the fast physics loop. Stock masses, force limits, actuator gains, and unassisted physics are retained. This executor currently runs native MuJoCo; it does not use MJX.

Each candidate gets two six-second trials. The two best distinct model candidates and the hand-tuned bound get three 20-second held-out trials. Speed is fitted after the first 1.6 seconds. A measured gallop requires repeated four-beat touchdown cycles, at least two actual all-feet-air intervals of 40 ms or longer, forward progress, and bounded posture/drift. A staggered command by itself does not qualify. The classifier and all thresholds are in `gallop.py`; this is an operational contact-based criterion, not a trained gait classifier.

The local `GaitSearch` Terse actor stores immutable proposals, measured trials, usage and reports under `artifacts/gait-search/terse/`. Running the same command resumes completed work. An interrupted rollout starts again; individual physics ticks are not checkpointed by this experimental executor. A process crash after an API response but before journal persistence can repeat that one API request. No requests are automatically retried after network ambiguity. Exported `journal.json`, contact traces, `report.json` and `best-policy.json` live alongside the Terse database. Use a new output directory/run ID when changing the controller or experiment configuration.

The dashboard's existing four-Ranger controller remains the validated paired gait. Experimental replay uses one shared periodic controller for all four legs; it does not yet run four independently deciding model actors or provide live gait switching through the durable Body.

The first search (2026-10-31) completed **6 model rounds, 18 proposed policies and 47 physics trials**. It did **not** find a validated gallop. The selected policy sustained **0.167–0.168 m/s** across three held-out 20-second trials, with no falls and at most 11.05° body tilt. It produced repeated four-beat cycles, with irregular contacts between some cycles, and **no all-feet-air intervals**. The hand-tuned bound achieved 0.141–0.151 m/s with real aerial phases but irregular touchdown order. Full validation summaries and the selected parameter vector are in `experiments/gait-search-results.json` and `experiments/four-beat-policy.json`.

```bash
uv run rangers gait-replay experiments/four-beat-policy.json --seconds 20
```

These tests vary only small initial base velocities on flat ground. They do not establish robustness to terrain, impacts or large disturbances. The next controller experiment is explicit timed push-off and landing recovery, then another bounded search for repeatable flight plus four-beat contact order.

API contracts: [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Validation

```bash
uv run pytest -q
RANGERS_INTEGRATION=1 uv run pytest tests/test_actors.py -q
uv run rangers smoke --render artifacts/go1.png
```

The smoke command writes `artifacts/smoke.json` and optionally a PNG. Checks cover all four legs lifting and landing in the rig, free-body standing, unequal-duration concurrency, contact-based timeout, invalid commands, paused time, and JSON checkpoint continuation. Crawl tests add three cycles under small initial velocity perturbations, support gating, safe stopping during shifting and swinging, failure handling, and exact native continuation from a mid-crawl checkpoint. They also assert that the rig and all applied external forces remain disabled. The opt-in actor suite starts real Terse processes and checks crash recovery mid-swing, replay of uncommitted physics, lost acknowledgements, duplicate commits, stale/conflicting proposals, competing leg reservations, durable stopping, agreement with the local baseline, durable velocity-goal changes, stale-goal rejection, and zero-goal holds. Reactive tests verify actual displacement in six commanded directions, uninterrupted motion targets on goal changes, and exact checkpoint continuation while turning.

## OpenAI key

Run this yourself in an interactive terminal:

```bash
python3 scripts/set_openai_key.py
```

It prompts without echoing the key, keeps it out of shell history, and atomically writes `.env` with owner-only permissions (`0600`). `.env` and secret variants are ignored by Git. The dashboard serves only its own HTML, state JSON, and rendered frames; it cannot serve arbitrary files.

Only `gait-search` reads `OPENAI_API_KEY` from the process environment or `.env` and calls the official OpenAI Responses endpoint. It loads just that variable without executing the file. The key is not sent to the browser, Terse, trial journals, or the model prompt. Ordinary simulation, evaluation and `gait-replay` do not make API requests. An ignored `.env` is still a plaintext local file, not an encrypted secret store.

## Code map

- `model.py`: pinned assets and leg-restricted damped least-squares inverse kinematics.
- `motions.py`: trajectories, simulation timing, and motion lifecycle.
- `crawl.py`: support geometry, centroidal stance control, and contact-gated crawl state machine.
- `simulation.py`: actuator assembly, native/MJX physics, observations, and native checkpoints.
- `rendering.py`: offscreen MuJoCo renderer with a visible calibration fixture.
- `actors.py`: local Terse process lifecycle, RPC adapter, checkpoint transactions and recovery.
- `actors/src/actor.ts`: durable Body arbiter, goal updates and four Ranger actor instances.
- `actors/src/policy.ts`: shared fixed/reactive/diagonal policies and single/pair arbitration.
- `trot.py`: simultaneous diagonal swings, two-foot support alignment and paired landing barriers.
- `gaits.json` / `gaits.py`: shared paired-gait timing, limits and body feedback profiles.
- `policy.py` / `evaluation.py`: physical observations and reproducible policy comparisons.
- `gallop.py`: experimental periodic MPC/IK executor and measured contact classification.
- `gait_search.py`: bounded OpenAI candidate loop, local Terse journal and held-out validation.
- `server.py` / `dashboard.html`: local interactive controls. All physics mutations happen on the main thread.

## Upstream assets

The installed `playground==0.2.0` package supplies the Go1 XML. Meshes and their license come from [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie/tree/1b86ece576591213e2b666ebf59508454200ca97/unitree_go1) at the revision pinned by Playground. Original assets and licenses remain in `.cache/go1/`. We recolor the legs and add the optional calibration constraint; the stock robot masses, joint limits, actuator gains, and solver settings are retained.

The actor integration uses [Terse’s official local runtime and persistence API](https://docs.useterse.ai/reference/typescript-sdk), pinned by `actors/bun.lock`. It uses single persisted-record assignments so each Body transition is atomic.
