import argparse
import json
from pathlib import Path

from .model import LEGS, download_assets
from .simulation import Simulation


def main():
    parser = argparse.ArgumentParser(description="Timed leg primitives on Playground Go1")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup", help="Download the pinned Go1 meshes")
    serve = sub.add_parser("serve", help="Open the local motion laboratory")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--backend", choices=["native", "mjx"], default="native")
    serve.add_argument("--free-body", action="store_true")
    smoke = sub.add_parser("smoke", help="Measure each leg's lift and touchdown")
    smoke.add_argument("--output", type=Path, default=Path("artifacts/smoke.json"))
    smoke.add_argument("--render", type=Path)
    crawl = sub.add_parser("crawl", help="Run a headless unassisted crawl and save measured results")
    crawl.add_argument("--cycles", type=int, default=3)
    crawl.add_argument("--backend", choices=["native", "mjx"], default="native")
    crawl.add_argument("--output", type=Path, default=Path("artifacts/crawl.json"))
    crawl.add_argument("--render", type=Path, help="Save a frame during the first swing")
    actors = sub.add_parser("actors", help="Run a crawl through four Terse Rangers and a durable Body")
    actors.add_argument("--cycles", type=int, default=3)
    actors.add_argument("--restart-at", type=int, help="Crash and restart Terse at this simulation tick")
    actors.add_argument("--port", type=int, default=7100, help="Local Terse port; 0 chooses a free port")
    actors.add_argument("--output", type=Path, default=Path("artifacts/actors.json"))
    actors.add_argument("--data-dir", type=Path, default=Path("artifacts/actor-run-state"))
    actors.add_argument("--policy", choices=["fixed", "reactive", "ordered", "trot"], default="fixed")
    actors.add_argument("--profile", choices=["baseline", "brisk", "fast"], default="baseline")
    actors.add_argument("--vx", type=float, default=.012, help="Forward goal, m/s")
    actors.add_argument("--vy", type=float, default=0., help="Leftward goal, m/s")
    actors.add_argument("--yaw-rate", type=float, default=0., help="Leftward turning goal, rad/s")
    evaluate = sub.add_parser("evaluate", help="Compare Ranger policies and timing profiles without RPC overhead")
    evaluate.add_argument("--seeds", type=int, default=5)
    evaluate.add_argument("--cycles", type=int, default=6)
    evaluate.add_argument("--suite", choices=["reactive", "paired", "speed"], default="reactive")
    evaluate.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "setup":
        print(download_assets())
    elif args.command == "serve":
        from .server import serve as run_server
        run_server(args.port, args.backend, not args.free_body)
    elif args.command == "evaluate":
        from .evaluation import evaluate
        evaluate(args.output or Path(f"artifacts/{args.suite}-evaluation.json"), args.seeds, args.cycles, args.suite)
    elif args.command == "actors":
        from .actors import ActorSession, TerseRuntime
        runtime = TerseRuntime(port=args.port, data_dir=args.data_dir)
        try:
            print("Starting local Terse actors…", flush=True)
            runtime.start()
            simulation = Simulation(rig=False)
            session = ActorSession.create(simulation, runtime, args.cycles, policy=args.policy, profile=args.profile,
                                          goal={"vx": args.vx, "vy": args.vy, "yaw_rate": args.yaw_rate})
            restarted = False
            for _ in range(args.cycles * 1000 + 250):
                session.step()
                if args.restart_at is not None and not restarted and simulation.tick >= args.restart_at:
                    print("Restart:", json.dumps(session.restart_demo(crash=True)), flush=True)
                    restarted = True
                if simulation.crawl.state.status != "running":
                    break
            report = simulation.crawl.telemetry(simulation)
            report.update(backend="native", calibration_rig=False, fallen=simulation.fallen,
                          coordination=session.telemetry(), motions=[m.to_dict() for m in simulation.history])
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps({k: v for k, v in report.items() if k not in ("events", "coordination", "motions")}, indent=2))
            if report["status"] != "completed" or report["fallen"]:
                raise SystemExit("Actor crawl failed; inspect the report")
            if args.restart_at is not None and not restarted:
                raise SystemExit("Episode ended before the requested restart tick")
        finally:
            runtime.stop()
    elif args.command == "crawl":
        simulation = Simulation(backend=args.backend, rig=False)
        simulation.start_crawl(args.cycles)
        rendered = False
        for _ in range(args.cycles * 1000 + 250):
            simulation.step()
            if args.render and not rendered and simulation.crawl.state.phase == "swing" and simulation.tick - simulation.crawl.state.phase_start >= 15:
                from .rendering import View
                view = View(simulation)
                try:
                    args.render.parent.mkdir(parents=True, exist_ok=True)
                    view.frame().save(args.render)
                    rendered = True
                finally:
                    view.close()
            if simulation.crawl.state.status != "running":
                break
        report = simulation.crawl.telemetry(simulation)
        report.pop("events")
        report.update(backend=args.backend, calibration_rig=False, fallen=simulation.fallen,
                      motions=[m.to_dict() for m in simulation.history])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: v for k, v in report.items() if k != "motions"}, indent=2))
        if report["status"] != "completed" or report["fallen"] or report["forward_m"] < .03 * args.cycles:
            raise SystemExit("Crawl check failed; inspect the report.")
    elif args.command == "smoke":
        simulation = Simulation()
        results = []
        for leg in LEGS:
            simulation.reset()
            action = simulation.start(leg)
            simulation.step(100)
            results.append({"leg": leg, "status": action.status, "reason": action.reason,
                            "clearance_m": action.max_clearance, "end_tick": action.end_tick,
                            "fallen": simulation.fallen})
        report = {"backend": "native", "calibration_rig": True, "legs": results}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        if args.render:
            from .rendering import View
            simulation.reset()
            simulation.start("FL")
            simulation.step(15)
            view = View(simulation)
            try:
                args.render.parent.mkdir(parents=True, exist_ok=True)
                view.frame().save(args.render)
            finally:
                view.close()
        if any(r["status"] != "completed" or r["fallen"] or r["clearance_m"] < 0.02 for r in results):
            raise SystemExit("Motion smoke check failed; inspect the report.")


if __name__ == "__main__":
    main()
