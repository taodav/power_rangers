"""Loopback-only dashboard. HTTP threads never mutate the simulation."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from queue import Empty, Queue
from threading import Lock, Thread
import time

from .motions import CONTROL_DT, DECISION_TICKS
from .rendering import View
from .simulation import Simulation
from .actors import ActorError, ActorSession, TerseRuntime


def serve(port: int, backend: str, rig: bool) -> None:
    simulation = Simulation(backend=backend, rig=rig)
    view = View(simulation)
    commands = Queue()
    lock = Lock()
    shared = {"state": simulation.state(), "frame": view.jpeg()}
    html = Path(__file__).with_name("dashboard.html").read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, payload, content_type="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/":
                self.send(200, html, "text/html; charset=utf-8")
            elif path == "/api/state":
                with lock:
                    payload = json.dumps(shared["state"]).encode()
                self.send(200, payload)
            elif path == "/frame.jpg":
                with lock:
                    frame = shared["frame"]
                self.send(200, frame, "image/jpeg")
            else:
                self.send(404, b'{"error":"Not found"}')

        def do_POST(self):
            if self.path != "/api/command":
                return self.send(404, b'{"error":"Not found"}')
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{self.headers.get('Host')}":
                return self.send(403, b'{"error":"Origin not allowed"}')
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.send(415, b'{"error":"Expected JSON"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192:
                    raise ValueError("Invalid payload size")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError("Expected object")
                reply = Queue(maxsize=1)
                commands.put((request, reply))
                code, response = reply.get(timeout=180)
                self.send(code, json.dumps(response).encode())
            except (ValueError, TypeError) as error:
                self.send(400, json.dumps({"error": str(error)}).encode())
            except Empty:
                self.send(503, b'{"error":"Simulation is busy"}')

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"Power Rangers: http://127.0.0.1:{port} (Ctrl+C to stop)", flush=True)
    running, step_budget = False, 0
    last_step, last_render = time.monotonic(), 0.0
    saved = None
    actor_session, actor_runtime = None, None
    try:
        while True:
            changed = False
            while not commands.empty():
                request, reply = commands.get_nowait()
                try:
                    command = request.get("command")
                    if command == "motion":
                        simulation.start(request.get("leg"), request.get("primitive", "swing_to"),
                                         float(request.get("duration", 0.6)), float(request.get("forward", 0.04)),
                                         float(request.get("clearance", 0.04)))
                    elif command == "run":
                        if simulation.fallen or (simulation.crawl and simulation.crawl.state.status == "failed"):
                            raise ValueError("Reset the failed episode first")
                        if actor_session and request.get("running") and simulation.crawl.state.status != "running":
                            raise ValueError("This actor episode has ended; start a new one")
                        running = bool(request.get("running"))
                        if actor_session and not running:
                            actor_session.flush()
                        step_budget = 0
                    elif command == "crawl":
                        if actor_session:
                            actor_session.flush()
                        actor_session = None
                        cycles = request.get("cycles", 3)
                        if type(cycles) is not int or not 1 <= cycles <= 20:
                            raise ValueError("Crawl cycles must be an integer from 1 to 20")
                        simulation.rig = False
                        simulation.reset()
                        simulation.start_crawl(cycles)
                        running, step_budget = True, 0
                    elif command in ("actor_crawl", "actor_resume"):
                        if simulation.backend != "native":
                            raise ValueError("Durable actor runs currently require native physics")
                        cycles = request.get("cycles", 3)
                        if type(cycles) is not int or not 1 <= cycles <= 20:
                            raise ValueError("Crawl cycles must be an integer from 1 to 20")
                        running, step_budget = False, 0
                        if actor_session and not actor_session.error:
                            actor_session.flush()
                        if actor_runtime is None:
                            actor_runtime = TerseRuntime()
                        actor_runtime.start()
                        if command == "actor_resume":
                            actor_session = ActorSession.resume(simulation, actor_runtime)
                        else:
                            actor_session = ActorSession.create(simulation, actor_runtime, cycles,
                                policy=request.get("policy", "fixed"), profile=request.get("profile", "baseline"),
                                goal=request.get("goal"))
                        running = command == "actor_crawl" and simulation.crawl.state.status == "running"
                    elif command == "actor_goal":
                        if actor_session is None:
                            raise ValueError("Start reactive Rangers first")
                        actor_session.set_goal(request.get("goal"))
                    elif command == "actor_restart":
                        if actor_session is None:
                            raise ValueError("Start or resume an actor crawl first")
                        running, step_budget = False, 0
                        actor_session.restart_demo()
                    elif command == "actor_recover":
                        if actor_session is None:
                            raise ValueError("No actor episode to recover")
                        running, step_budget = False, 0
                        actor_runtime.start()
                        actor_session.recover()
                    elif command == "stop_crawl":
                        if simulation.crawl is None or simulation.crawl.state.status != "running":
                            raise ValueError("No running crawl")
                        if actor_session:
                            actor_session.request_stop()
                        else:
                            simulation.crawl.request_stop()
                        running = True
                    elif command == "step":
                        running, step_budget = False, step_budget + DECISION_TICKS
                    elif command == "reset":
                        if actor_session and not actor_session.error:
                            actor_session.flush()
                        actor_session = None
                        simulation.rig = bool(request.get("rig", simulation.rig))
                        simulation.reset()
                        running, step_budget = False, 0
                    elif command == "save":
                        if actor_session:
                            raise ValueError("Actor episodes save automatically; use Resume saved")
                        saved = simulation.checkpoint()
                    elif command == "restore":
                        if actor_session:
                            raise ValueError("Use actor recovery for a durable episode")
                        if saved is None:
                            raise ValueError("Save a checkpoint first")
                        simulation.restore(saved)
                        running, step_budget = False, 0
                    else:
                        raise ValueError("Unknown command")
                    changed = True
                    reply.put((200, {"ok": True}))
                except (ValueError, TypeError, ActorError) as error:
                    if actor_session:
                        running, step_budget = False, 0
                    reply.put((400, {"error": str(error)}))
            now = time.monotonic()
            if (running or step_budget) and now - last_step >= CONTROL_DT:
                was_crawling = simulation.crawl is not None and simulation.crawl.state.status == "running"
                try:
                    if actor_session:
                        actor_session.step()
                    else:
                        simulation.step()
                    if step_budget:
                        step_budget -= 1
                        if step_budget == 0 and actor_session:
                            actor_session.flush()
                except (ActorError, ValueError) as error:
                    if actor_session:
                        actor_session.error = str(error)
                    running, step_budget = False, 0
                last_step = now
                if simulation.fallen:
                    running, step_budget = False, 0
                if was_crawling and simulation.crawl.state.status != "running":
                    running, step_budget = False, 0
                changed = True
            state = simulation.state()
            state.update(running=running, checkpoint_available=saved is not None,
                         actors=actor_session.telemetry() if actor_session else None)
            with lock:
                shared["state"] = state
            if changed or now - last_render > 0.5:
                if now - last_render >= 0.05:
                    frame = view.jpeg()
                    with lock:
                        shared["frame"] = frame
                    last_render = now
            time.sleep(0.002)
    except KeyboardInterrupt:
        print("Stopping simulator.")
    finally:
        if actor_runtime:
            actor_runtime.stop()
        httpd.shutdown()
        httpd.server_close()
        view.close()
