"""Runs the shipped speech-queue code from ui/app.js under Node with a fake audio
player: pausing, stopping and announcing must never leave Atlas mute or the mic deaf.
Skips if Node is not installed."""
import pathlib
import shutil
import subprocess
import unittest

HERE = pathlib.Path(__file__).resolve().parent
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is required to exercise the shipped browser logic")
class SpeechQueueTests(unittest.TestCase):
    def test_pause_stop_and_announce_never_jam_the_voice(self):
        proc = subprocess.run([NODE, str(HERE / "speech_harness.js"), str(HERE.parent / "ui" / "app.js")],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("FAIL", proc.stdout)


if __name__ == "__main__":
    unittest.main()
