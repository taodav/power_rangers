#!/usr/bin/env python3
"""Credential-free launcher. No Playground/JAX installation is needed for world mode."""
import argparse
import os
from pathlib import Path
import sys


def environment(root: Path, bun: Path, port: int, actor_port: int) -> dict[str, str]:
    state = root / ".cache" / "world"
    for name in ("home", "tmp", "bin"):
        (state / name).mkdir(parents=True, exist_ok=True)
    binary_dir = state / "bin"
    if any(path.name != "bun" for path in binary_dir.iterdir()):
        raise ValueError("Unexpected executable in the dedicated world bin directory")
    link = binary_dir / "bun"
    if link.is_symlink():
        if link.readlink() != bun:
            raise ValueError("The world Bun pin points to a different executable")
    elif link.exists():
        raise ValueError("The world Bun pin must be a symlink")
    else:
        link.symlink_to(bun)
    return {"HOME": str(state / "home"), "TMPDIR": str(state / "tmp"),
        "PATH": f"{binary_dir}:/usr/bin:/bin", "LANG": "en_US.UTF-8",
        "RANGERS_WORLD_PORT": str(port), "RANGERS_WORLD_ACTOR_PORT": str(actor_port)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8771)
    parser.add_argument("--actor-port", type=int, default=7111)
    parser.add_argument("--bun", type=Path, default=Path.home() / ".bun/bin/bun")
    args = parser.parse_args()
    if not all(1024 <= p <= 65535 for p in (args.port, args.actor_port)) or args.port == args.actor_port:
        parser.error("Use distinct unprivileged ports")
    bun = args.bun.expanduser().resolve()
    if not bun.is_file() or not os.access(bun, os.X_OK):
        parser.error("Pass --bun with the absolute path to an installed Bun executable")
    root = Path(__file__).resolve().parent
    if not (root / "node_modules/three").is_dir() or not (root / "actors/node_modules/terse-sdk").is_dir():
        parser.error("Install local dependencies: bun install --ignore-scripts && (cd actors && bun install --frozen-lockfile --ignore-scripts)")
    os.chdir(root)
    os.execve(str(bun), [str(bun), "--no-env-file", str(root / "actors/world-server.ts")],
              environment(root, bun, args.port, args.actor_port))


if __name__ == "__main__":
    main()
