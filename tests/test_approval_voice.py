"""Runs the shipped spoken-approval rule from ui/app.js under Node: a yes word inside some
other sentence ("I'm not sure, hold on") must never approve a command. Skips without Node."""
import pathlib
import shutil
import subprocess
import unittest

HERE = pathlib.Path(__file__).resolve().parent
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is required to exercise the shipped browser logic")
class ApprovalVoiceTests(unittest.TestCase):
    def test_only_a_plain_yes_approves(self):
        assert NODE is not None
        proc = subprocess.run([NODE, str(HERE / "approval_harness.js"), str(HERE.parent / "ui" / "app.js")],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("FAIL", proc.stdout)
        self.assertGreaterEqual(proc.stdout.count("PASS"), 25, proc.stdout)


if __name__ == "__main__":
    unittest.main()
