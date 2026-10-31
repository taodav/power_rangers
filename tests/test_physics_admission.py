"""Pure admission checks. These tests never start a physics process."""
import importlib.util
from pathlib import Path
import unittest

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


if __name__ == "__main__":
    unittest.main()
