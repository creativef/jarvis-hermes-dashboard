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


if __name__ == "__main__":
    unittest.main()
