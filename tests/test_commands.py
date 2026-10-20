import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import commands


class StateTests(unittest.TestCase):
    def test_state_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            state = pathlib.Path(td) / "state.json"
            with mock.patch.object(commands, "STATE_FILE", state):
                commands.update_state(lambda d: d["profile"].append("likes tea"))
                d = commands.load()
            self.assertEqual(d["profile"], ["likes tea"])

    def test_session_persistence(self):
        with tempfile.TemporaryDirectory() as td:
            state = pathlib.Path(td) / "state.json"
            with mock.patch.object(commands, "STATE_FILE", state):
                self.assertIsNone(commands.get_session())
                commands.set_session("20260808_031038_0ecb14")
                self.assertEqual(commands.get_session(), "20260808_031038_0ecb14")
                commands.set_session(None)
                self.assertIsNone(commands.get_session())

    def test_history(self):
        with tempfile.TemporaryDirectory() as td:
            state = pathlib.Path(td) / "state.json"
            with mock.patch.object(commands, "STATE_FILE", state):
                self.assertEqual(commands.get_history(), [])
                commands.record_turn("hello", "hi there")
                commands.record_turn("how are you", "fine")
                h = commands.get_history()
                self.assertEqual(len(h), 2)
                self.assertEqual(h[0]["user"], "hello")
                self.assertEqual(h[1]["assistant"], "fine")
                commands.clear_history()
                self.assertEqual(commands.get_history(), [])

    def test_set_settings_validation(self):
        with tempfile.TemporaryDirectory() as td:
            state = pathlib.Path(td) / "state.json"
            with mock.patch.object(commands, "STATE_FILE", state):
                cleaned, err = commands.set_settings({"permission": "bypass", "timeout": 300, "workdir": "/tmp"})
                self.assertIsNone(err)
                self.assertEqual(cleaned["permission"], "bypass")
                self.assertEqual(cleaned["timeout"], 300)
                self.assertEqual(commands.get_settings()["permission"], "bypass")
                # invalid inputs are rejected
                _, err = commands.set_settings({"timeout": 5})
                self.assertIsNotNone(err)
                _, err = commands.set_settings({"workdir": "/nonexistent/xyz"})
                self.assertIsNotNone(err)
                _, err = commands.set_settings({"permission": "yolo"})
                self.assertIsNotNone(err)


class BackgroundJobTests(unittest.TestCase):
    def test_background_launches_a_handoff_helper(self):
        from tools import handoff
        with mock.patch.object(handoff, "launch", return_value="ab12cd34") as launch:
            res = commands.handle("/background tidy the inbox")
        launch.assert_called_once_with("tidy the inbox")
        self.assertIsNone(res["message"])
        self.assertIn("ab12cd34", res["reply"])

    def _job(self, d, jid, **kw):
        job = {"id": jid, "status": "done", "mission": "m", "result": "ok",
               "started": 1.0, "finished": time.time()}
        job.update(kw)
        (d / f"{jid}.json").write_text(json.dumps(job))

    def test_finished_jobs_are_announced_exactly_once(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "done0001")
            self._job(d, "fail0002", status="failed", result="boom")
            self._job(d, "run00003", status="running", finished=None)
            with mock.patch.object(commands, "HANDOFF_DIR", d):
                first = sorted(j["id"] for j in commands.take_finished())
                second = commands.take_finished()
            self.assertEqual(first, ["done0001", "fail0002"])
            self.assertEqual(second, [])

    def test_old_announced_jobs_are_pruned(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "old00001", reported=True, finished=time.time() - 40 * 86400)
            (d / "old00001.log").write_text("x")
            self._job(d, "new00002", reported=True)
            with mock.patch.object(commands, "HANDOFF_DIR", d):
                commands.take_finished()
            self.assertEqual(sorted(p.name for p in d.iterdir()), ["new00002.json"])


if __name__ == "__main__":
    unittest.main()
