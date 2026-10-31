"""Pure admission checks. These tests never start a physics process."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import io
import json
import urllib.error

SPEC = importlib.util.spec_from_file_location("run_bounded", Path(__file__).resolve().parents[1] / "physics/run_bounded.py")
bounded = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bounded)


class AdmissionTests(unittest.TestCase):
    def test_good_measurements_admit(self):
        self.assertEqual(bounded.admission(12.5, "used = 8192.00M"), {"load1": 12.5, "swap_gib": 8.0})

    def test_load_limit_refuses(self):
        for load in (100, 173, float("inf"), float("nan"), -1):
            with self.assertRaises(RuntimeError):
                bounded.admission(load, "used = 8192.00M")

    def test_swap_limit_and_missing_measurement_refuse(self):
        for output in ("used = 10240.01M", "unavailable", "used = NaNM"):
            with self.assertRaises(RuntimeError):
                bounded.admission(1, output)

    def test_live_preview_modes_refuse_without_starting_any_executor(self):
        for state in ({"physics": {"time": 1}}, {"builder": {"status": "running"}},
                      {"builder": {"status": "paused"}}, {"builder": {"status": "starting"}}):
            with patch.object(bounded.urllib.request, "urlopen", side_effect=lambda *a, **k: io.BytesIO(json.dumps(state).encode())):
                with self.assertRaises(RuntimeError):
                    bounded.preview_gate()

    def test_completed_and_error_latched_snapshots_are_not_running_workers(self):
        for state in ({}, {"builder": {"status": "complete"}}, {"builder": {"status": "error"}},
                      {"physics": {"time": 1}, "error": "Worker stopped"}):
            with patch.object(bounded.urllib.request, "urlopen", side_effect=lambda *a, **k: io.BytesIO(json.dumps(state).encode())):
                bounded.preview_gate()

    def test_uninterpretable_preview_state_fails_closed(self):
        for raw in (b"not-json", b"[]", b'{"builder":1}', b"x"*1000001):
            with patch.object(bounded.urllib.request, "urlopen", side_effect=lambda *a, **k: io.BytesIO(raw)):
                with self.assertRaises(RuntimeError):
                    bounded.preview_gate()
        with patch.object(bounded.urllib.request, "urlopen", side_effect=urllib.error.URLError(TimeoutError())):
            with self.assertRaises(RuntimeError):
                bounded.preview_gate()
        with patch.object(bounded.urllib.request, "urlopen", side_effect=urllib.error.URLError(ConnectionRefusedError())):
            bounded.preview_gate()


if __name__ == "__main__":
    unittest.main()
