# Power Rangers

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

The page shows two connected loops: parallel Ranger proposals through shared Body memory and simulator feedback, then numerical execution of the accepted policies. The planning diagram follows actual progress, including individual saved responses and completed trials. Select a planning round and a Ranger to inspect its original explanation, parameter changes and measured feedback. New model calls include their elapsed wall time.

The execution timeline compares commanded swings with measured ground contact, confirmed touchdowns and missed deadlines. Faded bars preview the accepted policy; separate live/saved markers show checkpoint progress. The last three simulation seconds of 20 ms samples are saved with the controller and survive refreshes and recovery. Older episodes without samples are labeled explicitly. Manual calibration and tuning experiments remain available as headless commands.

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
- `server.py` / `dashboard.html`, `dashboard.css`, `dashboard.js`: the local demo and live planning/execution visualization; physics and rendering stay on the main thread.

The robot assets come from MuJoCo Playground 0.2.0 and its pinned [MuJoCo Menagerie Go1](https://github.com/google-deepmind/mujoco_menagerie/tree/1b86ece576591213e2b666ebf59508454200ca97/unitree_go1). Original assets and licenses remain in `.cache/go1/`. Actors use the official local Terse runtime, pinned by `actors/bun.lock`. Model requests use the official [OpenAI Responses function-calling API](https://developers.openai.com/api/docs/guides/function-calling).
