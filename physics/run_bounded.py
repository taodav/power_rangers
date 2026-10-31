"""Shared-host admission and a 5-minute process-group bound for native trials."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def child_environment():
    home, temporary = ROOT / ".cache/world/home", ROOT / ".cache/world/tmp"
    if not home.is_dir() or not temporary.is_dir():
        raise RuntimeError("Create the isolated world HOME and TMPDIR first")
    return {"HOME": str(home), "TMPDIR": str(temporary), "PATH": "/usr/bin:/bin",
            "LANG": "en_US.UTF-8", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
            "VECLIB_MAXIMUM_THREADS": "1"}


def admission(load, swap_output):
    if not math.isfinite(load) or load < 0:
        raise RuntimeError("Invalid host load measurement")
    match = re.search(r"used\s*=\s*([\d.]+)M", swap_output)
    if not match:
        raise RuntimeError("Could not measure swap; refusing native trial")
    swap = float(match.group(1)) / 1024
    if load >= 100 or swap > 10:
        raise RuntimeError(f"Host gate refused: load1 {load:.2f}, swap {swap:.2f} GiB")
    return {"load1": round(load, 2), "swap_gib": round(swap, 2)}


def gate():
    measured = subprocess.run(["/usr/sbin/sysctl", "vm.swapusage"], check=True, capture_output=True,
                              text=True, env=child_environment(), timeout=5)
    return admission(os.getloadavg()[0], measured.stdout)


def main():
    if not (sys.flags.isolated and sys.flags.dont_write_bytecode):
        raise RuntimeError("Run this wrapper with Python -I -B")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--walk", action="store_true")
    parser.add_argument("--gait", choices=("cautious", "brisk"), default="cautious")
    parser.add_argument("--gate-only", action="store_true")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--compare-gaits", action="store_true")
    parser.add_argument("--ranger", action="store_true")
    parser.add_argument("--deliver", action="store_true")
    args = parser.parse_args()
    if not 0 < args.seconds <= 90:
        parser.error("Use 0–90 simulated seconds")
    print(json.dumps({"admission": gate()}), flush=True)
    if args.gate_only:
        return
    command = [str(ROOT / ".venv/bin/python"), "-I", "-B", str(ROOT / "physics/megazord.py"), "--trial", str(args.seconds), "--gait", args.gait]
    if not args.walk:
        command.append("--stand")
    if args.test:
        test = "tests/test_ranger.py" if args.ranger else "tests/test_megazord.py"
        command = [str(ROOT / ".venv/bin/python"), "-I", "-B", str(ROOT / test)]
    elif args.compare_gaits:
        command = [str(ROOT / ".venv/bin/python"), "-I", "-B", str(ROOT / "physics/megazord.py"), "--compare-gaits", str(args.seconds)]
    elif args.ranger:
        command = [str(ROOT / ".venv/bin/python"), "-I", "-B", str(ROOT / "physics/ranger.py"), "--trial", str(args.seconds)]
        if args.deliver:
            command.append("--deliver")
    child = subprocess.Popen(command, cwd=ROOT, env=child_environment(), text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    deadline = time.monotonic()+300
    try:
        while True:
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Five-minute wall-clock bound reached")
            try:
                output, errors = child.communicate(timeout=min(5, remaining))
                break
            except subprocess.TimeoutExpired:
                gate()
    except (RuntimeError, TimeoutError, KeyboardInterrupt):
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
        raise RuntimeError("Owned native trial stopped at its host gate or wall-clock bound") from None
    print(output, end="")
    if errors:
        print(errors, file=sys.stderr)
    if child.returncode:
        raise SystemExit(child.returncode)


if __name__ == "__main__":
    main()
