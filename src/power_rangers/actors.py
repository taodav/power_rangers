"""Native simulation worker backed by real Terse actors.

One worker owns physics. The Body actor is authoritative: prepare a versioned
100ms round, execute it locally, then atomically commit the full checkpoint.
A failed/ambiguous RPC pauses physics; recover() reloads the authoritative state.
"""

from concurrent.futures import ThreadPoolExecutor
from collections import deque
import json
import os
from pathlib import Path
from queue import Queue, Empty
import secrets
import shutil
import signal
import subprocess
from threading import Event, Thread
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid

from .model import LEGS
from .motions import DECISION_TICKS
from .simulation import Simulation
from .policy import configure, observation, validate_goal

ROOT = Path(__file__).resolve().parents[2]


def encode(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


class ActorError(RuntimeError):
    pass


class TerseRuntime:
    """Own only the local runtime process group we created; retain its database."""
    def __init__(self, port=7100, data_dir=None):
        self.port = port
        self.data_dir = str(Path(data_dir).resolve()) if data_dir else ".durable-actors"
        self.latest = ROOT / "actors" / self.data_dir / "latest-episode.json"
        self.secret = secrets.token_urlsafe(32)
        self.process = None
        self.connection = None
        self.logs = deque(maxlen=30)

    def start(self):
        if self.process and self.process.poll() is None:
            return
        cached = ROOT / ".cache/bun/bun-darwin-aarch64/bun"
        bun = shutil.which("bun") or (str(cached) if cached.exists() else None)
        if not bun or not (ROOT / "actors/node_modules/terse-sdk").exists():
            raise ActorError("Install Bun and run 'cd actors && bun install' first")
        # Do not pass provider credentials into the scripted actor runtime.
        env = {key: value for key, value in os.environ.items()
               if key in {"PATH", "HOME", "TMPDIR", "SYSTEMROOT", "LANG"}}
        env.update(RANGERS_ACTOR_PORT=str(self.port), RANGERS_ACTOR_DATA=self.data_dir,
                   RANGERS_ACTOR_SECRET=self.secret)
        self.process = subprocess.Popen([bun, "--no-env-file", "run.ts"], cwd=ROOT / "actors",
                                        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, start_new_session=True)
        lines = Queue()
        ready = Event()
        process = self.process
        def read():
            for line in process.stdout:
                self.logs.append(line)
                if not ready.is_set():
                    lines.put(line)
            if not ready.is_set():
                lines.put(None)
        Thread(target=read, daemon=True).start()
        deadline, log = time.monotonic() + 120, []
        try:
            while time.monotonic() < deadline:
                try:
                    line = lines.get(timeout=min(1, max(.01, deadline - time.monotonic())))
                except Empty:
                    continue
                if line is None:
                    raise ActorError("Terse stopped during startup: " + "".join(log[-12:]))
                try:
                    value = json.loads(line)
                except ValueError:
                    log.append(line)
                    continue
                if value.get("ready"):
                    self.connection = value
                    ready.set()
                    return
            raise ActorError("Terse startup timed out")
        except Exception:
            self.stop(crash=True)
            raise

    def stop(self, crash=False):
        if not self.process:
            return
        try:
            # A failed startup may already have reaped Bun. Do not signal its
            # former process group after the child has exited.
            if self.process.poll() is None:
                os.killpg(self.process.pid, signal.SIGKILL if crash else signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process = None

    def restart(self, crash=False):
        self.stop(crash=crash)
        self.start()

    def call(self, actor, actor_id, method, *args):
        if not self.connection:
            raise ActorError("Terse is not running")
        request_id = str(uuid.uuid4())
        # Wire contract verified against durable-actors 0.14.6 client-runtime/client.js.
        url = f"{self.connection['controlPlaneUrl']}/v1/projects/power-rangers/actors/{actor}/{actor_id}/invoke"
        request = Request(url, data=encode({"requestId": request_id, "method": method, "args": list(args)}).encode(),
                          headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.secret}",
                                   "x-request-id": request_id}, method="POST")
        deadline = time.monotonic() + 40
        while True:
            try:
                with urlopen(request, timeout=20) as response:
                    result = json.load(response)
                break
            except HTTPError as error:
                try:
                    failure = json.load(error).get("error", {})
                    detail = f"{failure.get('code')}: {failure.get('message')}"
                except (ValueError, AttributeError):
                    detail = str(error)
                finally:
                    error.close()
                # A hard crash leaves the previous owner's lease until it expires.
                # Every method in this adapter is idempotent; retain the request ID.
                if error.code == 503 and time.monotonic() < deadline:
                    time.sleep(.5)
                    continue
                raise ActorError(f"Terse {actor}.{method}: {detail}") from error
            except (URLError, TimeoutError, OSError) as error:
                raise ActorError(f"Terse call failed ({actor}.{method}); recover before continuing: {error}") from error
        outcome = result.get("outcome", {})
        if outcome.get("type") != "completed":
            raise ActorError(outcome.get("message", str(result.get("error", outcome))))
        return json.loads(outcome["result"])


class ActorSession:
    def __init__(self, simulation: Simulation, runtime: TerseRuntime, episode: str):
        self.sim = simulation
        self.runtime = runtime
        self.episode = episode
        self.record = None
        self.pending = None
        self.before = None
        self.events = []
        self.round_ticks = 0
        self.recoveries = 0
        self.rpc_ms = 0
        self.last_recovery = None
        self.error = None

    @classmethod
    def create(cls, sim, runtime, cycles=3, policy="fixed", profile="baseline", goal=None):
        if sim.backend != "native":
            raise ValueError("Durable checkpoint runs currently require the native backend")
        sim.rig = False
        sim.reset()
        sim.start_crawl(cycles, external_policy=True)
        configure(sim, policy, profile, goal)
        session = cls(sim, runtime, uuid.uuid4().hex)
        session.record = runtime.call("Body", session.episode, "initialize", encode(sim.checkpoint()))
        runtime.latest.parent.mkdir(parents=True, exist_ok=True)
        temporary = runtime.latest.with_suffix(".tmp")
        temporary.write_text(encode({"episode": session.episode}))
        temporary.replace(runtime.latest)
        return session

    @classmethod
    def resume(cls, sim, runtime, episode=None):
        if sim.backend != "native":
            raise ValueError("Durable checkpoint runs currently require the native backend")
        if episode is None:
            if not runtime.latest.exists():
                raise ValueError("No saved actor episode yet")
            episode = json.loads(runtime.latest.read_text())["episode"]
        session = cls(sim, runtime, episode)
        session.recover()
        return session

    def recover(self):
        record = self.runtime.call("Body", self.episode, "inspect")
        self.sim.restore(json.loads(record["checkpoint"]))
        self.record = record
        self.pending = self.before = None
        self.events, self.round_ticks = [], 0
        self.error = None
        self.recoveries += 1

    def _begin(self):
        cp = self.sim.checkpoint()
        if self.record["pending"]:
            self.pending = self.record["pending"]
        else:
            intents = []
            if self.sim.crawl.state.phase == "awaiting_decision" and not self.record["stop"]:
                obs = encode(observation(self.sim, self.episode, self.record["revision"]))
                started = time.monotonic()
                # Concurrent RPCs to four actual actors, not four in-process policy objects.
                with ThreadPoolExecutor(max_workers=4) as pool:
                    intents = list(pool.map(lambda leg: self.runtime.call("Ranger", f"{self.episode}.{leg}",
                                                                          "propose", obs), LEGS))
                self.rpc_ms = (time.monotonic() - started) * 1000
            self.pending = self.runtime.call("Body", self.episode, "prepare", self.record["revision"], encode(intents))
        self.before = cp
        self.events, self.round_ticks = [], 0
        if self.pending["stop"]:
            self.sim.crawl.request_stop()
        elif self.pending.get("intents") and self.sim.crawl.state.policy == "trot":
            self.sim.crawl.reserve_batch(self.sim, self.pending["intents"])
            self._event("pair_shift", " + ".join(self.sim.crawl.state.selected_legs), "Both reservations accepted; aligning opposite diagonal support")
        elif self.pending["intent"]:
            self.sim.crawl.reserve_step(self.sim, self.pending["intent"])
            self._event("weight_shift", self.sim.crawl.leg, "Reservation accepted; waiting for stable support")
        elif self.sim.crawl.state.phase == "awaiting_decision":
            self.sim.crawl.reserve_hold(self.sim)
            self._event("hold", None, "All feet supporting; simulation clock advances during this hold")

    def _event(self, kind, leg, detail):
        self.events.append({"tick": self.sim.tick, "kind": kind, "leg": leg, "detail": detail})

    def step(self):
        if self.error:
            raise ActorError(self.error)
        try:
            if self.pending is None:
                self._begin()
            previous = self.sim.crawl.state.phase
            active_before = set(m.action_id for m in self.sim.active.values())
            self.sim.step()
            self.round_ticks += 1
            for motion in self.sim.active.values():
                if motion.action_id not in active_before:
                    self._event("swing", motion.leg, f"{motion.action_id}; deadline tick {motion.deadline_tick}")
            for motion in self.sim.history:
                if motion.action_id in active_before and motion.action_id not in {m.action_id for m in self.sim.active.values()}:
                    self._event(motion.status, motion.leg, f"{motion.action_id}: {motion.reason}")
            if self.sim.crawl.state.phase != previous:
                self._event(self.sim.crawl.state.phase, self.sim.crawl.leg, self.sim.crawl.state.reason or "Executor phase changed")
            if (self.sim.tick - self.before["tick"] >= DECISION_TICKS or
                    self.sim.crawl.state.phase == "awaiting_decision" or self.sim.crawl.state.status != "running"):
                self.flush()
        except Exception as error:
            self.error = str(error)
            raise

    def flush(self):
        """Commit a partial round before pausing, so the visible pose is durable."""
        if self.pending is None:
            return
        self.record = self.runtime.call("Body", self.episode, "commit", self.pending["id"],
                                        encode(self.sim.checkpoint()), encode(self.events))
        self.pending = self.before = None
        self.events = []

    def request_stop(self):
        self.flush()
        self.record = self.runtime.call("Body", self.episode, "requestStop")

    def set_goal(self, goal):
        goal = validate_goal(goal, self.sim.crawl.state.policy, self.sim.crawl.state.profile)
        self.flush()
        self.record = self.runtime.call("Body", self.episode, "setGoal", self.record["revision"], encode(goal))
        self.sim.restore(json.loads(self.record["checkpoint"]))

    def restart_demo(self, crash=False):
        """Restart the runtime with a durable motion in flight, then reload physics."""
        self.flush()
        before = self.sim.checkpoint()
        before_body = self.runtime.call("Body", self.episode, "identity")
        before_rangers = {leg: self.runtime.call("Ranger", f"{self.episode}.{leg}", "inspect") for leg in LEGS}
        self.runtime.restart(crash=crash)
        self.recover()
        after_body = self.runtime.call("Body", self.episode, "identity")
        after_rangers = {leg: self.runtime.call("Ranger", f"{self.episode}.{leg}", "inspect") for leg in LEGS}
        self.last_recovery = {
            "tick": self.sim.tick, "active_ids": [m.action_id for m in self.sim.active.values()],
            "checkpoint_equal": before == self.sim.checkpoint(),
            "body_reactivated": before_body["activation"] != after_body["activation"],
            "rangers_reactivated": all(before_rangers[l]["activation"] != after_rangers[l]["activation"] for l in LEGS),
            "decisions_preserved": all(before_rangers[l]["decisions"] == after_rangers[l]["decisions"] and
                                       before_rangers[l]["intent"] == after_rangers[l]["intent"] for l in LEGS),
        }
        if not all(self.last_recovery[k] for k in ("checkpoint_equal", "body_reactivated", "rangers_reactivated", "decisions_preserved")):
            raise ActorError("Restart verification failed")
        return self.last_recovery

    def telemetry(self):
        return {"episode": self.episode, "revision": self.record["revision"],
                "committed_tick": json.loads(self.record["checkpoint"])["tick"],
                "pending": self.pending, "intents": self.record["intents"],
                "timeline": self.record["timeline"][-80:] + self.events,
                "decision_wall_ms": self.rpc_ms, "recoveries": self.recoveries,
                "last_recovery": self.last_recovery, "error": self.error,
                "policy": self.sim.crawl.state.policy, "goal": self.sim.crawl.state.goal,
                "profile": self.sim.crawl.state.profile, "balance": "actuator-only stance controller"}
