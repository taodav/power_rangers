#!/usr/bin/env python3
"""Launch the isolated v3 API; does not change the stable integrated UI demo."""
import argparse
import importlib.util
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("world_launcher", ROOT / "run_world.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8775)
    parser.add_argument("--actor-port", type=int, default=7116)
    parser.add_argument("--bun", type=Path, default=Path.home() / ".bun/bin/bun")
    args = parser.parse_args()
    if not all(1024 <= port <= 65535 for port in (args.port, args.actor_port)) or args.port == args.actor_port:
        parser.error("Use distinct unprivileged ports")
    bun = args.bun.expanduser().resolve()
    if not bun.is_file() or not os.access(bun, os.X_OK):
        parser.error("Pass the absolute path to an installed Bun executable")
    if not (ROOT / "actors/node_modules/terse-sdk").is_dir() or not (ROOT / ".venv/bin/python").is_file():
        parser.error("Install the repo-local actor and physics requirements first")
    os.chdir(ROOT)
    os.execve(str(bun), [str(bun), "--no-env-file", str(ROOT / "actors/herd-server.ts")],
              launcher.environment(ROOT, bun, args.port, args.actor_port))


if __name__ == "__main__":
    main()
