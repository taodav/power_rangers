"""Focused, loopback-only demonstration of four independently timed Rangers."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from queue import Empty, Queue
from threading import Lock, Thread
import time

from .actors import ActorError, TerseRuntime
from .rendering import View
from .team import TeamSession
from .team_robot import TeamRobot


def serve(port=8765, backend='native', rig=False):
    if backend != 'native':
        raise ValueError('The durable Ranger demo uses native MuJoCo')
    robot = TeamRobot()
    view = View(robot)
    commands, lock = Queue(), Lock()
    shared = {'state': robot.state(), 'frame': view.jpeg()}
    html = Path(__file__).with_name('dashboard.html').read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, payload, content_type='application/json'):
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/':
                return self.send(200, html, 'text/html; charset=utf-8')
            with lock:
                if path == '/api/state':
                    return self.send(200, json.dumps(shared['state']).encode())
                if path == '/frame.jpg':
                    return self.send(200, shared['frame'], 'image/jpeg')
            self.send(404, b'{"error":"Not found"}')

        def do_POST(self):
            if self.path != '/api/command':
                return self.send(404, b'{"error":"Not found"}')
            origin = self.headers.get('Origin')
            if origin and origin != f"http://{self.headers.get('Host')}":
                return self.send(403, b'{"error":"Origin not allowed"}')
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.send(415, b'{"error":"Expected JSON"}')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 4096:
                    raise ValueError('Invalid request size')
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError('Expected an object')
                reply = Queue(maxsize=1)
                commands.put((payload, reply))
                code, result = reply.get(timeout=45)
                self.send(code, json.dumps(result).encode())
            except (ValueError, TypeError) as error:
                self.send(400, json.dumps({'error': str(error)}).encode())
            except Empty:
                self.send(503, b'{"error":"Demo is busy"}')

    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    Thread(target=httpd.serve_forever, daemon=True).start()
    print(f'Power Rangers demo: http://127.0.0.1:{port}', flush=True)
    runtime, session, running = None, None, False
    last_step, last_render = time.monotonic(), 0.
    try:
        while True:
            while not commands.empty():
                request, reply = commands.get_nowait()
                try:
                    command = request.get('command')
                    if command in ('start', 'resume_saved'):
                        if session and not session.error and not session.record['stopped'] and robot.team['status'] in ('ready', 'running'):
                            raise ValueError('Stop the current demo before starting another')
                        if session:
                            session.close()
                        if runtime is None:
                            runtime = TerseRuntime(port=0, data_dir=Path('artifacts/demo-state'))
                        runtime.start()
                        candidate = TeamRobot()
                        candidate_session = (TeamSession.create(candidate, runtime) if command == 'start'
                                             else TeamSession.resume(candidate, runtime))
                        robot, session = candidate, candidate_session
                        view.simulation = robot
                        running = not session.record['stopped'] and robot.team['status'] in ('ready', 'running')
                    elif command == 'pause':
                        if not session or not session.record['agreement']:
                            raise ValueError('Wait for the Rangers to finish planning')
                        running = False
                        session.flush()
                    elif command == 'play':
                        if not session or session.error or session.record['stopped'] or robot.team['status'] != 'running':
                            raise ValueError('Start a new demo or resume a saved episode')
                        running = True
                    elif command == 'stop':
                        running = False
                        if session:
                            session.stop()
                    elif command == 'restart_actors':
                        if not session or session.error:
                            raise ValueError('No active team to restart')
                        session.restart()
                    else:
                        raise ValueError('Unknown command')
                    reply.put((200, {'ok': True}))
                except (ActorError, ValueError, TypeError, OSError, RuntimeError) as error:
                    running = False
                    reply.put((400, {'error': str(error)}))
            now = time.monotonic()
            if running and session and now-last_step >= .02:
                try:
                    session.step()
                except (ActorError, ValueError) as error:
                    session.error = str(error)
                    running = False
                if robot.team['status'] in ('completed', 'failed'):
                    running = False
                last_step = now
            state = robot.state()
            state.update(running=running, actors=session.telemetry() if session else None)
            with lock:
                shared['state'] = state
            if now-last_render >= .08:
                frame = view.jpeg()
                with lock:
                    shared['frame'] = frame
                last_render = now
            time.sleep(.002)
    except KeyboardInterrupt:
        print('Stopping demo.', flush=True)
    finally:
        if session:
            session.close()
        if runtime:
            runtime.stop()
        httpd.shutdown()
        httpd.server_close()
        view.close()
