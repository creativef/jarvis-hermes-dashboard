import json
import os
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import commands


class AgentsSnapshotTests(unittest.TestCase):
    def _job(self, d, jid, **kw):
        job = {"id": jid, "status": "running", "mission": "do a thing", "result": "",
               "started": time.time() - 90, "finished": None}
        job.update(kw)
        (d / f"{jid}.json").write_text(json.dumps(job))

    def test_running_done_stalled_and_diagnostic(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "live0001", mission="Run a full READ-ONLY diagnostic of the platform.",
                      pid=os.getpid())
            (d / "live0001.log").write_text(f"{time.time():.3f}\ttool: read_file\n")
            self._job(d, "dead0002", pid=999999)
            self._job(d, "done0003", status="done", result="All finished.",
                      finished=time.time() - 10)
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                    mock.patch.object(commands, "_worker_pids", return_value={}):
                snap = commands.agents_snapshot()
            by = {a["id"]: a for a in snap["agents"]}
            self.assertEqual(by["live0001"]["status"], "running")
            self.assertTrue(by["live0001"]["diagnostic"])
            self.assertEqual(by["live0001"]["name"], "Diagnostic agent")
            self.assertEqual(by["live0001"]["step"], "tool: read_file")
            self.assertEqual(by["dead0002"]["status"], "stalled")
            self.assertEqual(by["done0003"]["result"], "All finished.")
            self.assertAlmostEqual(by["done0003"]["elapsed"], 80, delta=3)
            self.assertEqual(snap["running"], 1)
            self.assertEqual(snap["agents"][-1]["id"], "done0003")   # finished sorts last
            # read-only: nothing was rewritten or flagged as reported
            self.assertNotIn("reported", json.loads((d / "done0003.json").read_text()))


class HandoffWorkerTests(unittest.TestCase):
    def test_worker_streams_progress_and_result(self):
        import sys
        import types
        from tools import handoff
        fake = ("import sys,json\nsys.stdin.read()\n"
                "print(json.dumps({'type':'tool','name':'read_file'}),flush=True)\n"
                "print(json.dumps({'type':'result','text':'All good.'}),flush=True)\n")
        fake_runtime = types.SimpleNamespace(
            build_command=lambda m, s: [sys.executable, "-c", fake], WORKDIR=None,
            apply_settings=lambda s: None, user_name=lambda: "Sam")
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            (d / "w0000001.json").write_text(json.dumps(
                {"id": "w0000001", "status": "running", "mission": "x", "result": "",
                 "started": time.time(), "finished": None}))
            with mock.patch.object(handoff, "HANDOFF_DIR", d), \
                    mock.patch.object(handoff, "STATE_FILE", d / "missing.json"), \
                    mock.patch.dict(sys.modules, {"runtime": fake_runtime}):
                handoff.worker("w0000001", "x")
            job = json.loads((d / "w0000001.json").read_text())
            self.assertEqual((job["status"], job["result"]), ("done", "All good."))
            self.assertEqual(job["pid"], os.getpid())
            lines = (d / "w0000001.log").read_text().splitlines()
            self.assertTrue(lines[0].endswith("tool: read_file"))
            self.assertTrue(lines[-1].endswith("result: All good."))

    def test_worker_uses_dashboard_settings_and_name(self):
        # Settings → Permission must reach helpers too, not just the .env value.
        import sys
        import types
        from tools import handoff
        fake = ("import sys,json\nt=sys.stdin.read()\n"
                "print(json.dumps({'type':'result','text':'named' if 'for Dana.' in t else t[:80]}),flush=True)\n")
        applied = []
        fake_runtime = types.SimpleNamespace(
            build_command=lambda m, s: [sys.executable, "-c", fake], WORKDIR=None,
            apply_settings=applied.append, user_name=lambda: "os-user")
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            state = d / "state.json"
            state.write_text(json.dumps({"settings": {"permission": "normal", "user_name": "Dana"}}))
            (d / "w0000002.json").write_text(json.dumps(
                {"id": "w0000002", "status": "running", "mission": "x", "result": "",
                 "started": time.time(), "finished": None}))
            with mock.patch.object(handoff, "HANDOFF_DIR", d), \
                    mock.patch.object(handoff, "STATE_FILE", state), \
                    mock.patch.dict(sys.modules, {"runtime": fake_runtime}):
                handoff.worker("w0000002", "x")
            job = json.loads((d / "w0000002.json").read_text())
            self.assertEqual(applied, [{"permission": "normal", "user_name": "Dana"}])
            self.assertEqual(job["result"], "named")


if __name__ == "__main__":
    unittest.main()
