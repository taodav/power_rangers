# Assembly-world validation

**Historical visual-only packet.** The subsequent native-physics milestone and tighter joints are documented in `../physics/STATUS.md`; the limitations and versions below describe the first cut, not the current combined-walking path.

Measured locally on October 31, 2026. This packet applies to the new lightweight world, not the original Go1 locomotion claims.

## Results

- **17 Bun tests passed**, covering four hardware owners, bounded actor-specific patrol regions, deterministic goals, malformed inputs, all-four docking barrier, bounded motion, pause/error freeze, assembly/separation identity preservation, log retention, actor sequence/idempotency rules, and docking proximity checks. The actor guard cases mock the SDK; they are not durability evidence.
- **4 Python stdlib launcher tests passed**, covering an explicit child-environment allowlist, isolated HOME/TMPDIR, a pinned Bun symlink, refusal of extra binaries or changed pins, and no execution during environment construction. Fixtures use invented values only.
- **Dedicated TypeScript check passed** for the new actor, server, engine, unit tests, and restart probe. Original heavy locomotion suites were not run.
- **Real local Terse restart probe passed:** four actors each saved an assembly decision and docking receipt; the complete local runtime stopped and restarted against the same isolated data directory. All four durable records compared equal, all four ephemeral activation IDs changed, and each restored actor accepted decision 2. This proves this tested record round trip across graceful runtime restart—not crash consistency of the full world.
- **Desktop browser, 1440 × 1100:** four distinct actor IDs and activations; all four positions changed independently; pause froze simulation time and positions; assembly began with all four persisted receipts; an intermediate transform was inspected; combined patrol moved the shared core; separation retained all four identities and resumed their planning.
- **Mobile browser, 390 × 844:** four actor cards, WebGL world, responsive controls, and no horizontal page overflow. Desktop also had no horizontal overflow.
- Final connected browser pass reported **0 console errors and 0 warnings**. Intentionally stopping the preview then produced expected connection-refused network errors, a visible disconnected state, and disabled action controls.
- Owned world/runtime listeners on **8771 / 7111** and probe listener **7112** were absent after cleanup. Browser was closed. No commit, push, cloud deployment, or model call was made.

The final episode-ID hardening (full UUID rather than its first eight characters) was subsequently covered by the unit/typecheck round; the browser screenshots precede that identifier-only change.

## Local visual evidence

Ignored, local-only screenshots:

- `.cache/world/evidence/roaming-desktop.png`
- `.cache/world/evidence/combined-desktop.png`
- `.cache/world/evidence/mobile.png`

The models are original, procedural Ranger-style geometry. Each robot's meshes persist through transformation; extra gauntlet plates unfold, while its helmet retracts and arms fold. The shared core unfolds its torso and head. This is explicitly a visual, kinematic assembly—not mechanical validation.

## Repeating the real-runtime probe

Use the project's approved bounded test slot. Stop any world preview first, check available memory/processes, and select an unused unprivileged port. From the repo root, with a concrete installed Bun executable:

```bash
mkdir -p .cache/world/home .cache/world/tmp
env -i \
  HOME="$PWD/.cache/world/home" \
  TMPDIR="$PWD/.cache/world/tmp" \
  PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
  RANGERS_WORLD_ACTOR_PORT=7112 \
  /absolute/path/to/bun --no-env-file actors/world-restart-probe.ts
```

The probe refuses additional environment names and mismatched fixture paths before starting tools. It runs four actors, reuses its own unique data directory across one runtime restart, has bounded RPC timeouts, and stops its owned runtime in `finally`. Its 45-second timer requests runtime shutdown; this is not an OS-enforced wall-clock kill of every possible descendant.

## Environment and network boundary

Versions measured: Bun **1.4.4**, Python **3.12.1**, Three.js **0.187.0**, `terse-sdk` / `terse-cli` **0.14.9**, transitive `durable-actors` **0.14.6**.

`run_world.py` executes the concrete Bun path with `--no-env-file`, an isolated HOME/TMPDIR, a dedicated bin directory containing only its Bun pin, and named local ports. It does not forward ambient credentials, proxies, injection variables, or host config overrides. The Python invocation uses `-I -B`.

By inspected source, the pinned SDK adds its host/runtime binary directories to child PATH, starts the native local runtime, and gives it a newly generated local-only authentication value. The key is not printed or saved by our code; the SDK passes it to its runtime via argv, so do not dump full process arguments. The installer may download the pinned native release from GitHub, verifies its SHA-256, and caches it under the isolated HOME. Dependency installation uses the npm registry. These are intentional public downloads, not an assertion that the entire launcher is network-sandboxed.

This is environment isolation, **not OS/host isolation**. The application endpoints and measured runtime listeners bind numeric loopback. World commands enforce same-origin requests, a local Host header, and a 512-byte JSON body limit. No hosted Terse, Inkwell, Agent Relay, or model service is used by this mode.

## Remaining boundaries

No humanoid physics, learned locomotion, physical docking, terrain collision planning, whole-world crash recovery, autonomous LLM inference, or peer-message transport has been validated here. Actor records survive the tested runtime restart; world poses/time/logs remain in memory, and a launcher restart starts a new episode.
