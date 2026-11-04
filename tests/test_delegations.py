"""Delegated subagents: what the Agents tab reads about `delegate_task` children."""
import json
import os
import pathlib
import tempfile
import time
import unittest

import delegations


def _stamp(offset=0):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + offset))


class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.tmpd = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self.tmpd.name)

    def tearDown(self):
        self.tmpd.cleanup()

    def _batch(self, delegation_id, tasks, *, completed=None, started=None):
        """Write a delegation the way Hermes does: a manifest plus one log per child."""
        d = self.tmp / "cache" / "delegation" / "live" / delegation_id
        d.mkdir(parents=True)
        entries = []
        for i, t in enumerate(tasks):
            log = d / f"task-{i}.log"
            log.write_text(t.get("log_text", "20:27:09 tool     | -> terminal(ls)\n"), encoding="utf-8")
            if t.get("age") is not None:
                when = time.time() - t["age"]
                os.utime(log, (when, when))
            entry = {"index": i, "goal": t.get("goal", "do a thing"),
                     "log": str(log), "status": t.get("status", "running")}
            if t.get("exit_reason"):
                entry["exit_reason"] = t["exit_reason"]
            entries.append(entry)
        manifest = {"delegation_id": delegation_id, "started": started or _stamp(),
                    "task_count": len(entries), "model": None, "provider": None, "tasks": entries}
        if completed:
            manifest["completed"] = completed
        (d / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return d

    def test_a_running_child_shows_with_its_live_step(self):
        self._batch("deleg_aaa", [{"log_text": "20:27:09 tool     | -> terminal(pytest)\n"}])
        rows = delegations.snapshot(profile_home=self.tmp)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["kind"], r["status"], r["stoppable"]), ("delegation", "running", False))
        self.assertEqual(r["id"], "deleg_aaa-0")
        self.assertEqual(r["step"], "tool · -> terminal(pytest)")
        self.assertIn("do a thing", r["brief"])
        self.assertEqual(r["result"], "")                 # no exit reason yet, same shape as helper jobs

    def test_a_finished_batch_reads_done(self):
        self._batch("deleg_bbb", [{"status": "completed"}], completed=_stamp())
        r = delegations.snapshot(profile_home=self.tmp)[0]
        self.assertEqual(r["status"], "done")
        self.assertIsNotNone(r["finished"])
        self.assertIsNotNone(r["elapsed"])

    def test_a_failed_child_is_failed_not_running(self):
        # A child that said "timeout" must never be reported as still going.
        self._batch("deleg_ccc", [{"status": "timeout"}], completed=_stamp())
        self.assertEqual(delegations.snapshot(profile_home=self.tmp)[0]["status"], "failed")

    def test_an_unknown_terminal_word_is_failed(self):
        # A child that reported something terminal we do not recognise must never look
        # like it is still going.
        self._batch("deleg_kkk", [{"status": "exploded"}], completed=_stamp())
        self.assertEqual(delegations.snapshot(profile_home=self.tmp)[0]["status"], "failed")

    def test_a_recorded_exit_reason_is_surfaced(self):
        self._batch("deleg_lll", [{"status": "failed", "exit_reason": "max turns reached"}],
                    completed=_stamp())
        self.assertEqual(delegations.snapshot(profile_home=self.tmp)[0]["result"],
                         "max turns reached")

    def test_a_child_that_went_quiet_without_a_stamp_is_stalled(self):
        # The parent session dying mid-delegation never stamps `completed`: without this the
        # tab would show the ghost forever, which is the bug we just fixed for helper jobs.
        self._batch("deleg_ddd", [{"age": delegations._STALE_AFTER_S + 600}])
        self.assertEqual(delegations.snapshot(profile_home=self.tmp)[0]["status"], "stalled")

    def test_a_missing_log_still_resolves_a_status(self):
        d = self.tmp / "cache" / "delegation" / "live" / "deleg_eee"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps(
            {"delegation_id": "deleg_eee", "started": _stamp(),
             "tasks": [{"index": 0, "goal": "g", "log": str(d / "nope.log"), "status": "running"}]}),
            encoding="utf-8")
        r = delegations.snapshot(profile_home=self.tmp)[0]
        # no transcript to age from, so it is not called dead on that basis alone
        self.assertEqual((r["status"], r["step"]), ("running", ""))

    def test_an_unreadable_manifest_is_skipped_not_raised(self):
        d = self.tmp / "cache" / "delegation" / "live" / "deleg_bad"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(delegations.snapshot(profile_home=self.tmp), [])

    def test_no_delegations_at_all_is_empty(self):
        self.assertEqual(delegations.snapshot(profile_home=self.tmp / "nowhere"), [])

    def test_running_sorts_before_finished(self):
        self._batch("deleg_run", [{}])
        self._batch("deleg_done", [{"status": "completed"}], completed=_stamp())
        self.assertEqual([r["status"] for r in delegations.snapshot(profile_home=self.tmp)],
                         ["running", "done"])

    def test_the_limit_is_respected(self):
        self._batch("deleg_many", [{} for _ in range(5)])
        self.assertEqual(len(delegations.snapshot(limit=2, profile_home=self.tmp)), 2)

    def test_shorten_strips_the_stamp_and_flattens_the_separator(self):
        self.assertEqual(delegations._shorten("20:27:09 tool     | -> terminal(ls)"),
                         "tool · -> terminal(ls)")
        self.assertEqual(delegations._shorten("just a line"), "just a line")
        self.assertEqual(delegations._shorten(""), "")

    def test_status_mapping(self):
        self.assertEqual(delegations._status({"status": "running"}, False, None), "running")
        self.assertEqual(delegations._status({"status": "running"}, True, None), "done")
        self.assertEqual(delegations._status({}, True, None), "done")
        self.assertEqual(delegations._status({"status": "completed"}, False, None), "done")
        self.assertEqual(delegations._status({"status": "error"}, False, None), "failed")
        self.assertEqual(delegations._status({"status": "running"}, False, 999999), "stalled")


if __name__ == "__main__":
    unittest.main()
