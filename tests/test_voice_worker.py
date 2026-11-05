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


REPO = pathlib.Path(__file__).resolve().parent.parent
FAKE_WORKER = """
import json, os, sys
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    print(json.dumps({"ok": True, "pid": os.getpid()}), flush=True)
"""
SETUP = """
import json, os, pathlib, sys
sys.path.insert(0, {repo!r})
import voice
voice.HERE, voice.VENV_PY, voice.WORKER = pathlib.Path({td!r}), pathlib.Path(sys.executable), pathlib.Path({worker!r})
"""
BEFORE_EXEC = SETUP + """
voice._spawn()
pid = voice._call({{"op": "tts"}})["pid"]
os.execve(sys.executable, [sys.executable, {after!r}, str(pid)], dict(os.environ, **voice.handover_env()))
"""
AFTER_EXEC = SETUP + """
pid = voice._call({{"op": "tts"}})["pid"]
print(json.dumps({{"before": int(sys.argv[1]), "after": pid, "ready": voice.ready(),
                  "env_cleared": "JARVIS_VOICE_WORKER" not in os.environ}}), flush=True)
voice._proc.kill()
"""


class SelfRestartHandoverTests(unittest.TestCase):
    """A dashboard self-restart (execve) keeps the loaded worker, so there is no warm-up
    window in which lines come out in the macOS fallback voice."""

    def test_the_same_worker_answers_after_the_exec(self):
        import json
        import subprocess
        with tempfile.TemporaryDirectory() as td:
            worker = pathlib.Path(td) / "worker.py"
            worker.write_text(FAKE_WORKER)
            fmt = dict(repo=str(REPO), td=td, worker=str(worker))
            after = pathlib.Path(td) / "after.py"
            after.write_text(AFTER_EXEC.format(**fmt))
            before = pathlib.Path(td) / "before.py"
            before.write_text(BEFORE_EXEC.format(after=str(after), **fmt))
            out = subprocess.run([sys.executable, str(before)], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(res["before"], res["after"])          # no new worker, no reload
        self.assertTrue(res["ready"])
        self.assertTrue(res["env_cleared"])

    def test_no_handover_mid_request_or_without_a_worker(self):
        with mock.patch.object(voice, "_proc", None):
            self.assertEqual(voice.handover_env(), {})         # nothing to hand over: plain restart
        fake = mock.Mock()
        fake.poll.return_value = None
        with mock.patch.object(voice, "_proc", fake), mock.patch.dict(voice._state, {"ready": True}):
            voice._lock.acquire()                              # a line is being synthesised
            try:
                self.assertIsNone(voice.handover_env(timeout=0.1))
            finally:
                voice._lock.release()


if __name__ == "__main__":
    unittest.main()
