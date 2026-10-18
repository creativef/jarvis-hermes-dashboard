"""The local voice worker must never make a request wait on a model load."""
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

import voice


class VoiceWorkerTests(unittest.TestCase):
    def setUp(self):
        self._saved = (voice._proc, dict(voice._state))
        voice.clear_audio_cache()

    def tearDown(self):
        if voice._proc is not None and voice._proc is not self._saved[0] and voice._proc.poll() is None:
            voice._proc.kill()
        voice._proc = self._saved[0]
        voice._state.clear(); voice._state.update(self._saved[1])
        voice.clear_audio_cache()

    def test_speech_falls_back_at_once_while_worker_warms(self):
        with mock.patch.object(voice, "worker_installed", return_value=True), \
             mock.patch.object(voice, "local_available", return_value=True), \
             mock.patch.object(voice, "_speak_say", return_value=b"SAY"):
            voice._start_lock.acquire()               # what a model load in progress looks like
            try:
                t0 = time.monotonic()
                audio, _ = voice.speak("Hello there.")
                self.assertEqual(audio, b"SAY")
                self.assertLess(time.monotonic() - t0, 1.0)
            finally:
                voice._start_lock.release()

    def test_spawn_gives_up_after_warm_timeout(self):
        with tempfile.TemporaryDirectory() as td:
            worker = pathlib.Path(td) / "stall.py"
            worker.write_text("import time\ntime.sleep(5)\n")   # never prints its ready line
            with mock.patch.object(voice, "HERE", pathlib.Path(td)), \
                 mock.patch.object(voice, "VENV_PY", pathlib.Path(sys.executable)), \
                 mock.patch.object(voice, "WORKER", worker), \
                 mock.patch.object(voice, "WARM_TIMEOUT", 0.3):
                t0 = time.monotonic()
                voice._spawn()
                self.assertLess(time.monotonic() - t0, 2.0)
                self.assertFalse(voice._state["ready"])
                self.assertIn("not ready", voice._state["error"])
                voice._proc.wait(timeout=2)            # it was killed, not left running


if __name__ == "__main__":
    unittest.main()
