"""Morning brief data: auto once a day, one fetch at a time, tolerant reading."""
import datetime
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import brief
import commands
from tools import handoff


class BriefTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.bdir, self.hdir = root / "brief", root / "handoff"
        self.hdir.mkdir()
        self.launched = []

        def fake_launch(mission, quiet=False):
            jid = f"b{len(self.launched):07d}"
            self.launched.append((mission, quiet))
            (self.hdir / f"{jid}.json").write_text(json.dumps(
                {"id": jid, "status": "running", "mission": mission[:200], "started": time.time()}))
            return jid
        self.patches = [mock.patch.object(brief, "BRIEF_DIR", self.bdir),
                        mock.patch.object(commands, "HANDOFF_DIR", self.hdir),
                        mock.patch.object(handoff, "launch", side_effect=fake_launch)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _today_file(self):
        return self.bdir / f"{datetime.date.today().isoformat()}.json"

    def _finish_job(self, result):
        for f in self.hdir.glob("*.json"):
            job = json.loads(f.read_text())
            job.update(status="done", result=result)
            f.write_text(json.dumps(job))

    def test_first_view_of_the_day_starts_one_quiet_fetch(self):
        self.assertEqual(brief.state()["status"], "none")
        self.assertTrue(brief.state()["auto"])
        st = brief.start()
        self.assertEqual(st["status"], "running")
        mission, quiet = self.launched[0]
        self.assertTrue(quiet)
        self.assertIn(str(self._today_file()), mission)
        self.assertIn("READ ONLY", mission)
        brief.start()                                   # second tab / reload: no second fetch
        brief.start(force=True)                         # even ↻ waits for the running one
        self.assertEqual(len(self.launched), 1)

    def test_ready_data_is_read_tolerantly_and_capped(self):
        brief.start()
        self.bdir.mkdir(exist_ok=True)
        rows = [{"label": f"Store {i} orders today " + "x" * 80, "value": str(i)} for i in range(12)]
        self._today_file().write_text("```json\n" + json.dumps(
            {"business": rows, "calendar": [{"when": "Tue 10:00", "what": "Dentist"}],
             "missing": []}) + "\n```")
        self._finish_job("Brief data written.")
        st = brief.state()
        self.assertEqual(st["status"], "ready")
        self.assertEqual(len(st["data"]["business"]), 8)
        self.assertLessEqual(len(st["data"]["business"][0]["label"]), 60)
        self.assertEqual(st["data"]["calendar"], [{"when": "Tue 10:00", "what": "Dentist"}])
        self.assertFalse(st["auto"])

    def test_failed_fetch_explains_and_refresh_retries(self):
        brief.start()
        self._finish_job("I couldn't reach Shopify.")
        st = brief.state()
        self.assertEqual((st["status"], st["error"]), ("failed", "I couldn't reach Shopify."))
        self.assertFalse(st["auto"])                    # no automatic retry loop
        brief.start(force=True)
        self.assertEqual(len(self.launched), 2)

    def test_no_auto_fetch_when_nothing_was_connected_last_time(self):
        self.bdir.mkdir()
        (self.bdir / "2000-01-01.json").write_text(json.dumps({"business": [], "calendar": [], "missing": ["all"]}))
        st = brief.state()
        self.assertEqual(st["status"], "none")
        self.assertFalse(st["auto"])
        brief.start()
        self.assertEqual(self.launched, [])
        brief.start(force=True)                         # ↻ still works
        self.assertEqual(len(self.launched), 1)


if __name__ == "__main__":
    unittest.main()
