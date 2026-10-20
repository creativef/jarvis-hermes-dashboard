import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import runtime

FAKE = pathlib.Path(__file__).resolve().parent / "fake_hermes"


class BuildCommandTests(unittest.TestCase):
    def test_default_flags(self):
        with mock.patch.object(runtime, "PERMISSION", "normal"), \
             mock.patch.object(runtime, "MODEL", ""), \
             mock.patch.object(runtime, "TOOLSETS", ""):
            cmd = runtime.build_command("hi", None)
        self.assertIn("chat", cmd)
        self.assertEqual(cmd[cmd.index("--format") + 1], "stream-json")
        self.assertEqual(cmd[cmd.index("--query-file") + 1], "-")
        self.assertIn("--source", cmd)
        # regression: --profile was an invalid `chat` flag (it's global-only)
        self.assertNotIn("--profile", cmd)
        self.assertNotIn("--yolo", cmd)

    def test_yolo_resume_model_toolsets(self):
        with mock.patch.object(runtime, "PERMISSION", "bypass"), \
             mock.patch.object(runtime, "MODEL", "deepseek-v4-pro"), \
             mock.patch.object(runtime, "TOOLSETS", "terminal,file"):
            cmd = runtime.build_command("hi", "20260808_031038_0ecb14")
        self.assertIn("--yolo", cmd)
        self.assertEqual(cmd[cmd.index("--resume") + 1], "20260808_031038_0ecb14")
        self.assertEqual(cmd[cmd.index("--model") + 1], "deepseek-v4-pro")
        self.assertEqual(cmd[cmd.index("--toolsets") + 1], "terminal,file")


class ValidSessionTests(unittest.TestCase):
    def test_valid(self):
        self.assertTrue(runtime.valid_session("20260808_031038_0ecb14"))

    def test_invalid(self):
        self.assertFalse(runtime.valid_session(""))
        self.assertFalse(runtime.valid_session(None))
        self.assertFalse(runtime.valid_session("x"))
        self.assertFalse(runtime.valid_session("demo"))


class RunStreamTests(unittest.TestCase):
    def test_streams_structured_events(self):
        with tempfile.TemporaryDirectory() as td:
            log = pathlib.Path(td) / "fake.log"
            env = {
                "HERMES_CMD": f"{sys.executable} {FAKE}",
                "FAKE_HERMES_LOG": str(log),
                "FAKE_HERMES_SESSION": "20260101_000000_test99",
            }
            with mock.patch.dict(os.environ, env, clear=False), \
                 mock.patch.object(runtime, "RUNTIME", "hermes"):
                runtime._TTL_CACHE.clear()
                events = list(runtime.run("run the fake", None, None))

            kinds = [e.get("t") for e in events]
            for want in ("status", "delta", "tool", "usage", "complete"):
                self.assertIn(want, kinds)

            complete = next(e for e in events if e.get("t") == "complete")
            self.assertEqual(complete["session_id"], "20260101_000000_test99")
            self.assertEqual(complete["text"], "hello")

            # the fake recorded what the runtime actually invoked on the CLI
            self.assertTrue(log.exists())
            record = json.loads(log.read_text().strip().splitlines()[-1])
            argv = record["argv"]
            self.assertIn("--format", argv)
            self.assertIn("--query-file", argv)
            self.assertIn("run the fake", record["prompt"])


class IdleTimeoutTests(unittest.TestCase):
    def _run_with_idle(self, idle_seconds, env_extra):
        with tempfile.TemporaryDirectory() as td:
            env = {
                "HERMES_CMD": f"{sys.executable} {FAKE}",
                "FAKE_HERMES_LOG": str(pathlib.Path(td) / "fake.log"),
            }
            env.update(env_extra)
            with mock.patch.dict(os.environ, env, clear=False), \
                 mock.patch.object(runtime, "RUNTIME", "hermes"), \
                 mock.patch.object(runtime, "IDLE_TIMEOUT", idle_seconds):
                runtime._TTL_CACHE.clear()
                return list(runtime.run("hi", None, None))

    def test_long_tool_call_is_not_killed(self):
        # the fake stalls 2.5s between tool_use and tool_result; a 1s idle
        # timeout must NOT kill it because a tool is in flight
        events = self._run_with_idle(1, {"FAKE_HERMES_TOOL_STALL_MS": "2500"})
        kinds = [e.get("t") for e in events]
        self.assertIn("complete", kinds)
        self.assertNotIn("error", kinds)

    def test_silent_hang_is_killed(self):
        # the fake emits nothing for 2.5s; a 1s idle timeout must kill it
        events = self._run_with_idle(1, {"FAKE_HERMES_STALL_MS": "2500"})
        kinds = [e.get("t") for e in events]
        self.assertIn("error", kinds)


class CancelAndShutdownTests(unittest.TestCase):
    def _env(self, td, **extra):
        env = {"HERMES_CMD": f"{sys.executable} {FAKE}",
               "FAKE_HERMES_LOG": str(pathlib.Path(td) / "fake.log")}
        env.update(extra)
        return env

    def test_user_stop_is_a_cancel_not_an_error(self):
        # Esc kills Hermes (exit -15). That must come out as `cancelled`, because the
        # server forgets the conversation on `error`.
        import threading
        with tempfile.TemporaryDirectory() as td, \
             mock.patch.dict(os.environ, self._env(td, FAKE_HERMES_STALL_MS="5000"), clear=False), \
             mock.patch.object(runtime, "RUNTIME", "hermes"), \
             mock.patch.object(runtime, "BACKEND", "cli"):
            runtime._TTL_CACHE.clear()
            threading.Timer(0.8, runtime.cancel_active).start()
            events = list(runtime.run("hi", None, None))
        kinds = [e.get("t") for e in events]
        self.assertIn("cancelled", kinds)
        self.assertNotIn("error", kinds)

    def test_slow_exit_after_answer_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as td, \
             mock.patch.dict(os.environ, self._env(td, FAKE_HERMES_EXIT_STALL_MS="7000"), clear=False), \
             mock.patch.object(runtime, "RUNTIME", "hermes"):
            runtime._TTL_CACHE.clear()
            events = list(runtime.run("hi", None, None))
        kinds = [e.get("t") for e in events]
        self.assertIn("complete", kinds)
        self.assertNotIn("error", kinds)


class UserNameTests(unittest.TestCase):
    def test_falls_back_to_os_user(self):
        name = runtime.user_name()
        self.assertIsInstance(name, str)
        self.assertTrue(name)

    def test_reads_name_override(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            (home / "SOUL.md").write_text("Name: Alice Johnson\nmore")
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(home)}, clear=False), \
                 mock.patch.object(runtime, "PROFILE", "default"):
                self.assertEqual(runtime.user_name(), "Alice Johnson")


if __name__ == "__main__":
    unittest.main()
