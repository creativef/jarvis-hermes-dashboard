import json
import os
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
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                 mock.patch.object(commands, "_live_worker_pids", return_value={"run00003": 1}):
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

    def test_job_liveness_rules(self):
        now = time.time()

        def job(**kw):
            return dict({"id": "j", "status": "running"}, **kw)

        self.assertTrue(commands.job_is_live(job(pid=1), live={"j": 1}))          # ps lists our worker
        self.assertFalse(commands.job_is_live(job(pid=1), live={"other": 9}))     # ps answered, not ours
        # ps answered with no workers at all: a saved pid that is alive belongs to some
        # other process now (pids are recycled, e.g. after a reboot) — the job is dead.
        self.assertFalse(commands.job_is_live(job(pid=os.getpid()), live={}))
        with mock.patch.object(commands, "_live_worker_pids", return_value=None):  # ps failed -> probe the pid
            self.assertFalse(commands.job_is_live(job(pid=999999)))
            self.assertTrue(commands.job_is_live(job(pid=os.getpid())))
        self.assertTrue(commands.job_is_live(job(started=now), live={}))          # worker still starting
        self.assertFalse(commands.job_is_live(job(started=now - 3600), live={}))  # never wrote a pid
        self.assertFalse(commands.job_is_live(job(status="done"), live={"j": 1}))

    def test_a_dead_worker_is_not_a_running_job(self):
        # A reboot or a kill leaves the job file saying "running" forever; /status, the job
        # count and the morning brief all used to report that ghost as work in progress.
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "ghost001", status="running", finished=None, pid=999999,
                      started=time.time() - 3600)
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                 mock.patch.object(commands, "_live_worker_pids", return_value={}):
                self.assertEqual(commands.jobs_snapshot(), [])
                self.assertEqual(commands.running_jobs(), [])

    def test_a_live_worker_is_still_a_running_job(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "live0001", status="running", finished=None, started=time.time())
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                 mock.patch.object(commands, "_live_worker_pids", return_value={"live0001": os.getpid()}):
                self.assertEqual([j["id"] for j in commands.jobs_snapshot()], ["live0001"])
                # counted as running, not as a stalled worker
                self.assertEqual(commands.agents_snapshot()["running"], 1)

    def test_delegated_children_are_shown_alongside_helper_jobs(self):
        # The Agents tab must show the platform's delegated children too, not just the
        # dashboard's own helper jobs. Delegations are read-only: no Stop, but named and
        # counted like the rest.
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "done0001")                     # a finished helper
            delegated = [{"id": "deleg_x-0", "kind": "delegation", "brief": "fix the things",
                          "status": "running", "step": "tool · ls", "step_at": time.time(),
                          "started": time.time(), "finished": None, "elapsed": 1.0,
                          "result": "", "quiet": False, "diagnostic": False,
                          "stoppable": False, "model": "deepseek/deepseek-v4-pro"}]
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                 mock.patch.object(commands.delegations, "snapshot", return_value=delegated):
                snap = commands.agents_snapshot()
        agents = snap["agents"]
        assert isinstance(agents, list)
        self.assertIn("delegation", [a["kind"] for a in agents])
        self.assertEqual(snap["running"], 1)             # the delegated child, running
        dg = next(a for a in agents if a["kind"] == "delegation")
        self.assertEqual((dg["stoppable"], dg["model"]), (False, "deepseek/deepseek-v4-pro"))
        self.assertTrue(dg["name"])                      # named by the one shared namer


    def test_a_dead_helper_is_announced_once_as_failed(self):
        # Killed by a reboot, the worker never records an outcome. Without this the job is
        # never announced (you wait forever) and never pruned.
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "ghost001", status="running", finished=None, pid=os.getpid(),
                      started=time.time() - 3600)
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                 mock.patch.object(commands, "_live_worker_pids", return_value={}):
                first = commands.take_finished()
                again = commands.take_finished()
            self.assertEqual([(j["id"], j["status"]) for j in first], [("ghost001", "failed")])
            self.assertEqual(again, [])
            saved = json.loads((d / "ghost001.json").read_text())
            self.assertEqual((saved["status"], saved["reported"]), ("failed", True))

    def test_a_live_helper_is_not_announced(self):
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "live0001", status="running", finished=None, started=time.time() - 3600)
            with mock.patch.object(commands, "HANDOFF_DIR", d), \
                 mock.patch.object(commands, "_live_worker_pids", return_value={"live0001": 1}):
                self.assertEqual(commands.take_finished(), [])
            self.assertEqual(json.loads((d / "live0001.json").read_text())["status"], "running")

    def test_write_atomic_leaves_no_temp_file_behind(self):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "x.json"
            commands.write_atomic(p, '{"a": 1}')
            commands.write_atomic(p, '{"a": 2}')
            self.assertEqual(json.loads(p.read_text())["a"], 2)
            self.assertEqual([f.name for f in pathlib.Path(td).iterdir()], ["x.json"])

    def test_announcing_a_job_writes_it_atomically(self):
        # A crash mid-write leaves truncated JSON, which the reader skips silently — so the
        # job would never be announced at all. No temp file may survive either.
        with tempfile.TemporaryDirectory() as td:
            d = pathlib.Path(td)
            self._job(d, "done0001", status="done", finished=time.time())
            with mock.patch.object(commands, "HANDOFF_DIR", d):
                commands.take_finished()
            self.assertTrue(json.loads((d / "done0001.json").read_text())["reported"])
            self.assertEqual([f.name for f in d.iterdir() if f.name.startswith(".")], [])


if __name__ == "__main__":
    unittest.main()
