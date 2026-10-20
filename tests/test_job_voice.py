"""Voice control for helper jobs: answered locally, no model call."""
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import commands
from tools import handoff


class JobVoiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = pathlib.Path(self.tmp.name)
        self.p = mock.patch.object(commands, "HANDOFF_DIR", self.d)
        self.p.start()

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()

    def _job(self, jid, mission, **kw):
        job = {"id": jid, "status": "running", "mission": mission, "result": "",
               "started": time.time() - 300, "finished": None}
        job.update(kw)
        (self.d / f"{jid}.json").write_text(json.dumps(job))

    def test_stop_the_named_job(self):
        self._job("fly00001", "Research the ten cheapest flights from Stockholm to Tobago.")
        self._job("etsy0002", "Pull Etsy sales stats for October.")
        with mock.patch.object(commands, "stop_job", return_value=({"stopping": True}, None)) as stop:
            res = commands.handle("Stop the flights job.")
        stop.assert_called_once_with("fly00001")
        self.assertIsNone(res["message"])
        self.assertIn("Stopping", res["reply"])

    def test_vague_stop_needs_exactly_one_running(self):
        self._job("only0001", "Pull Etsy sales stats for October.")
        with mock.patch.object(commands, "stop_job", return_value=({"stopping": True}, None)) as stop:
            commands.handle("atlas, stop the job")
        stop.assert_called_once_with("only0001")
        self._job("two00002", "Research flights.")
        with mock.patch.object(commands, "stop_job") as stop:
            res = commands.handle("stop the job")
        stop.assert_not_called()
        self.assertIn("couldn't tell", res["reply"])

    def test_stop_all(self):
        self._job("a0000001", "One thing to research.")
        self._job("b0000002", "Another thing to research.")
        self._job("c0000003", "Done thing.", status="done")
        with mock.patch.object(commands, "stop_job", return_value=({}, None)) as stop:
            res = commands.handle("stop all jobs")
        self.assertEqual(sorted(c.args[0] for c in stop.call_args_list), ["a0000001", "b0000002"])
        self.assertEqual(res["reply"], "Stopping 2 helpers.")

    def test_what_did_it_find(self):
        self._job("fly00001", "Research cheap flights to Tobago.", status="done",
                  result="The cheapest is 6,240 kronor on KLM, leaving 3 November.", finished=time.time())
        res = commands.handle("What did the flight job find?")
        self.assertIn("6,240 kronor", res["reply"])
        self.assertIsNone(res["message"])
        res = commands.handle("how's the tobago helper going")
        self.assertIn("KLM", res["reply"])

    def test_running_job_progress(self):
        self._job("fly00001", "Research cheap flights to Tobago.")
        (self.d / "fly00001.log").write_text(f"{time.time():.3f}\ttool: web_search\n")
        res = commands.handle("how is the flight job doing")
        self.assertIn("still working, 5 minutes in", res["reply"])
        self.assertIn("web_search", res["reply"])

    def test_start_a_job_keeps_the_wording(self):
        with mock.patch.object(handoff, "launch", return_value="new00001") as launch:
            res = commands.handle("Hey Atlas, start a job to compare Printful and Printify base prices for hoodies")
        launch.assert_called_once_with("Compare Printful and Printify base prices for hoodies")
        self.assertIsNone(res["message"])

    def test_ordinary_sentences_still_reach_hermes(self):
        for text in ("stop talking", "how is the weather", "what did you find", "start over",
                     "the job market is tough", "start a job"):
            res = commands.handle(text)
            self.assertFalse(res and res.get("intent", "").startswith("job"), text)


if __name__ == "__main__":
    unittest.main()
