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


class KeepHermesWarmTests(unittest.TestCase):
    """auto backend: start a gateway when none answers, then run turns through it."""

    def _free_port(self):
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def _wait(self, want, secs=15):
        import time
        end = time.monotonic() + secs
        while time.monotonic() < end and runtime.gateway_status()[0] != want:
            time.sleep(0.1)
        return runtime.gateway_status()[0]

    def test_starts_gateway_runs_turns_through_it_and_stops_it(self):
        port = self._free_port()
        with tempfile.TemporaryDirectory() as td:
            env_file = pathlib.Path(td) / ".env"
            log = pathlib.Path(td) / "fake.log"
            with mock.patch.dict(os.environ, {"HERMES_CMD": f"{sys.executable} {FAKE}",
                                              "FAKE_HERMES_LOG": str(log)}, clear=False), \
                 mock.patch.object(runtime, "RUNTIME", "hermes"), \
                 mock.patch.object(runtime, "BACKEND", "auto"), \
                 mock.patch.object(runtime, "START_GATEWAY", True), \
                 mock.patch.object(runtime, "API_URL", f"http://127.0.0.1:{port}"), \
                 mock.patch.object(runtime, "API_KEY", ""), \
                 mock.patch.object(runtime, "_GATEWAY_LOG", pathlib.Path(td) / "gateway.log"):
                runtime._TTL_CACHE.clear()
                runtime._HEALTH.update(at=-1e9)
                try:
                    runtime.start_gateway(env_file)
                    self.assertEqual(self._wait("ours"), "ours")
                    self.assertIn("JARVIS_API_KEY=", env_file.read_text())
                    events = list(runtime.run("hi there", None, "PERSONA"))
                    proc = runtime._GATEWAY["proc"]
                finally:
                    runtime.stop_gateway()
            kinds = [e.get("t") for e in events]
            self.assertIn("complete", kinds)
            self.assertEqual("".join(e["text"] for e in events if e.get("t") == "delta"), "warm hello.")
            sent = [json.loads(x)["gateway_run"] for x in log.read_text().splitlines() if "gateway_run" in x]
            self.assertEqual(sent[0]["input"], "hi there")          # persona is not in the transcript
            self.assertIn("PERSONA", sent[0]["instructions"])
            self.assertIsNotNone(proc.poll())                         # our gateway was stopped
            self.assertEqual(runtime.gateway_status()[0], "off")

    def test_uses_a_gateway_that_is_already_running(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Ok(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers()
                self.wfile.write(b"{}")
        srv = HTTPServer(("127.0.0.1", 0), Ok)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with mock.patch.object(runtime, "RUNTIME", "hermes"), \
                 mock.patch.object(runtime, "BACKEND", "auto"), \
                 mock.patch.object(runtime, "START_GATEWAY", True), \
                 mock.patch.object(runtime, "API_KEY", "k"), \
                 mock.patch.object(runtime, "API_URL", f"http://127.0.0.1:{srv.server_address[1]}"), \
                 mock.patch.object(subprocess_mod(), "Popen", side_effect=AssertionError("must not spawn")):
                runtime.start_gateway("/nonexistent/.env")
                self.assertEqual(self._wait("external", 5), "external")
                self.assertIsNone(runtime._GATEWAY["proc"])
        finally:
            srv.shutdown()
            runtime._GATEWAY.update(proc=None, state="off", note="")


def subprocess_mod():
    import subprocess
    return subprocess


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
