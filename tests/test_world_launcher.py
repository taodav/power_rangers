"""Stdlib-only launcher checks; no runtime, native simulator, or external tools."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("run_world", Path(__file__).resolve().parents[1] / "run_world.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_explicit_environment_drops_invented_ambient_inputs(self):
        sentinel = "INVENTED_TEST_SENTINEL_NOT_A_CREDENTIAL"
        hostile = {name: sentinel for name in ("INK_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV", "HTTPS_PROXY", "DURABLE_ACTORS_BINARY")}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, hostile):
            root = Path(directory)
            result = launcher.environment(root, Path("/pinned/bin/bun"), 8771, 7111)
            self.assertEqual(set(result), {"HOME", "TMPDIR", "PATH", "LANG", "RANGERS_WORLD_PORT", "RANGERS_WORLD_ACTOR_PORT"})
            self.assertNotIn(sentinel, result.values())
            self.assertEqual(result["PATH"], f"{root / '.cache/world/bin'}:/usr/bin:/bin")
            self.assertEqual((root / ".cache/world/bin/bun").readlink(), Path("/pinned/bin/bun"))
            self.assertEqual(result["HOME"], str(root / ".cache/world/home"))
            self.assertTrue(Path(result["TMPDIR"]).is_dir())
            self.assertEqual(result["RANGERS_WORLD_PORT"], "8771")

    def test_no_process_is_started_by_environment_construction(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(os, "execve") as execute:
            launcher.environment(Path(directory), Path("/pinned/bun"), 8771, 7111)
            execute.assert_not_called()

    def test_extra_binary_is_refused_without_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher.environment(root, Path("/pinned/bun"), 8771, 7111)
            (root / ".cache/world/bin/invented-helper").write_text("never execute")
            with self.assertRaises(ValueError):
                launcher.environment(root, Path("/pinned/bun"), 8771, 7111)

    def test_changed_bun_pin_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher.environment(root, Path("/pinned/bun"), 8771, 7111)
            with self.assertRaises(ValueError):
                launcher.environment(root, Path("/different/bun"), 8771, 7111)


if __name__ == "__main__":
    unittest.main()
