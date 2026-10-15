import json
import pathlib
import tempfile
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

    def test_reconcile_orphaned_missions(self):
        with tempfile.TemporaryDirectory() as td:
            state = pathlib.Path(td) / "state.json"
            state.write_text(json.dumps({
                "profile": [], "goal": "", "personality": "", "tasks": [],
                "missions": [
                    {"id": "abc", "mission": "old", "status": "running", "at": 1.0},
                    {"id": "def", "mission": "done", "status": "done", "at": 1.0, "finished": 2.0},
                ],
            }))
            with mock.patch.object(commands, "STATE_FILE", state):
                commands._reconcile_orphaned_missions()
                d = commands.load()
            by_id = {m["id"]: m for m in d["missions"]}
            self.assertEqual(by_id["abc"]["status"], "failed")
            self.assertEqual(by_id["abc"]["result"], "interrupted by dashboard restart")
            self.assertEqual(by_id["def"]["status"], "done")


class BackgroundJobTests(unittest.TestCase):
    def test_running_background(self):
        self.assertFalse(commands.running_background())
        with mock.patch.dict(commands.JOBS, {"abc": {"id": "abc", "status": "running"}}, clear=True):
            self.assertTrue(commands.running_background())
        self.assertFalse(commands.running_background())


if __name__ == "__main__":
    unittest.main()
