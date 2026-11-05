"""Runs the shipped greeting from ui/greeting.js under Node with fakes: it must never
speak on load, only ever on a deliberate gesture, and at most once per calendar day —
a server restart on the same day must stay silent. Skips if Node is not installed.
"""
import pathlib
import shutil
import subprocess
import unittest

HERE = pathlib.Path(__file__).resolve().parent
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is required to exercise the shipped browser logic")
class GreetingGateTests(unittest.TestCase):
    def test_the_greeting_is_once_a_day_and_never_on_load(self):
        assert NODE is not None
        proc = subprocess.run([NODE, str(HERE / "greeting_harness.js"), str(HERE.parent / "ui" / "greeting.js")],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("FAIL", proc.stdout)
        self.assertGreaterEqual(proc.stdout.count("PASS"), 14, proc.stdout)


if __name__ == "__main__":
    unittest.main()