"""Prompt locally for an OpenAI key without echoing it or logging it."""

import getpass
import os
from pathlib import Path
import sys
import tempfile


def main() -> None:
    if not sys.stdin.isatty():
        raise SystemExit("Run this yourself in an interactive terminal; do not pipe the key.")
    destination = Path(__file__).resolve().parents[1] / ".env"
    key = getpass.getpass("OpenAI API key (hidden): ").strip()
    if not key or any(c.isspace() for c in key):
        raise SystemExit("No key saved: enter a nonempty key without whitespace.")
    existing = destination.read_text() if destination.exists() else ""
    lines = [line for line in existing.splitlines() if not line.strip().startswith("OPENAI_API_KEY=")]
    lines.append(f"OPENAI_API_KEY={key}")
    fd, temporary = tempfile.mkstemp(prefix=".env.", dir=destination.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write("\n".join(lines) + "\n")
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Saved to the project's ignored .env file with owner-only permissions.")
    print("No API request was made.")


if __name__ == "__main__":
    main()
