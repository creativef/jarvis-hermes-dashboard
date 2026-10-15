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


if __name__ == "__main__":
    unittest.main()
