import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

import brain
import commands
import runtime
import voice

FAKE = pathlib.Path(__file__).resolve().parent / "fake_hermes"


class FastPathIntentRouterTests(unittest.TestCase):
    def setUp(self):
        self._brain_root = brain.ROOT
        self.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = pathlib.Path(self.tmp.name)
        commands._DEPT_CACHE.update(root=None, at=0.0, data=None)
        dept = brain.ROOT / "departments" / "business-operations"
        dept.mkdir(parents=True)
        (dept / "business-operations.md").write_text(
            "# Business and Operations department\n\n"
            "## Remit\nKeep the business running.\n\n"
            "## Sub-teams\n"
            "- [[development]] - Development - Dashboard and store code.\n"
            "- [[tech-automation]] - Tech and Automation - Scripts and integrations.\n",
            encoding="utf-8",
        )
        (dept / "development").mkdir()
        (dept / "tech-automation").mkdir()

    def tearDown(self):
        brain.ROOT = self._brain_root
        commands._DEPT_CACHE.update(root=None, at=0.0, data=None)
        self.tmp.cleanup()

    def test_all_required_fast_path_queries_under_50ms(self):
        queries = [
            ("what time is it", "time"),
            ("status", "status"),
            ("jobs", "jobs"),
            ("departments", "departments"),
            ("teams", "teams"),
            ("clear", "clear"),
            ("help", "help"),
            ("who are you", "who_are_you"),
        ]
        with mock.patch("subprocess.run", side_effect=AssertionError("subprocess must not run on fast-path")), \
             mock.patch("subprocess.Popen", side_effect=AssertionError("model must not spawn on fast-path")):
            for q, expected_intent in queries:
                t0 = time.perf_counter()
                res = commands.handle(q)
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                self.assertIsNotNone(res, f"expected fast-path match for {q!r}")
                self.assertIsNone(res["message"], f"{q!r} should be answered locally with message=None")
                self.assertTrue(res.get("reply"), f"{q!r} should return a non-empty reply")
                self.assertEqual(res.get("intent"), expected_intent)
                self.assertLess(elapsed_ms, 50.0, f"{q!r} took {elapsed_ms:.2f}ms (>= 50ms)")

    def test_fast_path_content_and_courtesy_prefixes(self):
        depts = commands.fast_path("Hey Atlas, what departments do we have?")
        assert depts is not None
        self.assertIn("Business & Operations", str(depts["reply"]))

        teams = commands.fast_path("Please list teams!")
        assert teams is not None
        self.assertIn("Development", str(teams["reply"]))
        self.assertIn("Tech & Automation", str(teams["reply"]))

        who = commands.fast_path("Atlas, who are you?")
        assert who is not None
        self.assertIn("Atlas", str(who["reply"]))

        # Complex prompt is NOT intercepted by fast-path
        self.assertIsNone(commands.handle("Design a 3-email Black Friday sequence for our hoodie line"))


class AcknowledgementAndSentenceStreamTests(unittest.TestCase):
    def setUp(self):
        runtime.clear_cache()
        voice.clear_audio_cache()

    def test_ack_phrases_by_intent(self):
        self.assertEqual(runtime.classify_ack_intent("check shopify sales and orders"), "sales")
        self.assertEqual(runtime.classify_ack_intent("prepare my morning brief"), "brief")
        self.assertEqual(runtime.classify_ack_intent("ask the marketing team"), "team")
        self.assertIn("store", runtime.ack_phrase("check shopify sales"))
        self.assertEqual(voice.ack_phrase("unknown random prompt"), "On it.")

    def test_sentence_buffer_streams_sentences_and_preserves_abbreviations(self):
        sb = runtime.SentenceBuffer()
        # "Mr." must not trigger a false sentence break
        self.assertEqual(sb.feed("Good morning, Mr."), [])
        sents = sb.feed(" Thompson. Sales are up 15%! ")
        self.assertEqual(sents, [
            (0, "Good morning, Mr. Thompson."),
            (1, "Sales are up 15%!"),
        ])
        self.assertEqual(sb.feed("Checking runtime.py "), [])
        sents2 = sb.feed("now. Tail fragment")
        self.assertEqual(sents2, [(2, "Checking runtime.py now.")])
        self.assertEqual(sb.flush(), [(3, "Tail fragment")])

    def test_runtime_run_emits_ack_first_and_sentence_chunks(self):
        script = (
            "import json, sys\n"
            "sys.stdin.read()\n"
            "print(json.dumps({'type':'system','subtype':'init','model':'fake','session_id':'20261016_120000_abcdef'}), flush=True)\n"
            "print(json.dumps({'type':'text','text':'First sentence is ready. '}), flush=True)\n"
            "print(json.dumps({'type':'text','text':'Second sentence for Mr. Thompson! '}), flush=True)\n"
            "print(json.dumps({'type':'text','text':'Final trailing thought'}), flush=True)\n"
            "print(json.dumps({'type':'result','session_id':'20261016_120000_abcdef','exit_code':0,"
            "'text':'First sentence is ready. Second sentence for Mr. Thompson! Final trailing thought'}), flush=True)\n"
        )
        with tempfile.TemporaryDirectory() as td:
            fake_cli = pathlib.Path(td) / "fake_stream.py"
            fake_cli.write_text(script, encoding="utf-8")
            env = {"HERMES_CMD": f"{sys.executable} {fake_cli}"}
            with mock.patch.dict(os.environ, env, clear=False), \
                 mock.patch.object(runtime, "RUNTIME", "hermes"):
                runtime.seed_probe_cache(tools=["terminal"])
                events = list(runtime.run("check store sales", None, None))

        self.assertGreaterEqual(len(events), 5)
        self.assertEqual(events[0]["t"], "ack")
        self.assertEqual(events[0]["intent"], "sales")
        self.assertTrue(events[0]["text"])

        sentences = [e for e in events if e.get("t") == "sentence"]
        self.assertEqual(
            [s["text"] for s in sentences],
            [
                "First sentence is ready.",
                "Second sentence for Mr. Thompson!",
                "Final trailing thought",
            ],
        )
        self.assertEqual([s["index"] for s in sentences], [0, 1, 2])
        # First sentence event arrives before the second delta is even processed
        first_sent_pos = next(i for i, e in enumerate(events) if e.get("t") == "sentence" and e.get("index") == 0)
        complete_pos = next(i for i, e in enumerate(events) if e.get("t") == "complete")
        self.assertLess(first_sent_pos, complete_pos)

    def test_voice_audio_cache_and_speak_stream(self):
        calls = []

        def fake_say(text):
            calls.append(text)
            return f"WAV:{text}".encode("utf-8")

        with mock.patch.object(voice, "worker_installed", return_value=False), \
             mock.patch.object(voice, "local_available", return_value=True), \
             mock.patch.object(voice, "_speak_say", side_effect=fake_say):
            warmed = voice.prewarm_acks()
            self.assertEqual(warmed, len(set(voice.ACK_PHRASES.values())))
            calls_after_warm = len(calls)
            # Repeat ack synthesis hits cache with zero extra _speak_say calls
            audio, mime = voice.speak("On it.")
            self.assertEqual(mime, "audio/wav")
            self.assertEqual(audio, b"WAV:On it.")
            self.assertEqual(len(calls), calls_after_warm)

            stream_evs = [
                {"t": "ack", "text": "On it."},
                {"t": "sentence", "text": "First spoken sentence.", "index": 0},
            ]
            out = list(voice.speak_stream(stream_evs))
            self.assertEqual(len(out), 2)
            self.assertEqual(out[0]["type"], "ack")
            self.assertEqual(out[1]["type"], "sentence")
            self.assertEqual(out[1]["audio"], b"WAV:First spoken sentence.")


class NoResponseCacheTests(unittest.TestCase):
    def test_repeat_status_question_asks_hermes_again(self):
        # A repeated question must never be answered from a stale cache: the second
        # "status" may be about a job that has moved on since the first.
        with tempfile.TemporaryDirectory() as td:
            log = pathlib.Path(td) / "fake.log"
            env = {"HERMES_CMD": f"{sys.executable} {FAKE}", "FAKE_HERMES_LOG": str(log),
                   "FAKE_HERMES_SESSION": "20261016_090000_status1"}
            with mock.patch.dict(os.environ, env, clear=False), \
                 mock.patch.object(runtime, "RUNTIME", "hermes"):
                for _ in range(2):
                    evs = list(runtime.run("what's the status of the background job?", None, None))
                    self.assertEqual(evs[-1]["t"], "complete")
                self.assertEqual(len(log.read_text().strip().splitlines()), 2)


class ProbePrewarmTests(unittest.TestCase):
    def setUp(self):
        runtime.clear_cache()

    def tearDown(self):
        runtime.clear_cache()

    def test_prewarm_probe_cache_avoids_subprocess_spawns(self):
        env = {"HERMES_CMD": f"{sys.executable} {FAKE}"}
        with mock.patch.dict(os.environ, env, clear=False), \
             mock.patch.object(runtime, "RUNTIME", "auto"):
            status = runtime.prewarm_probes(background=False)
            for key in ("hermes_version", "tools_snapshot", "model_info", "user_name"):
                self.assertTrue(status[key]["warm"], f"probe {key} should be warm")
                self.assertGreater(status[key]["ttl_remaining"], 0.0)

            # With warm probes, calling runtime_kind(), hermes_tools_snapshot(),
            # model_info(), and user_name() must not spawn any subprocess.
            with mock.patch("subprocess.run", side_effect=AssertionError("probe cache should prevent subprocess")):
                self.assertEqual(runtime.runtime_kind(), "hermes")
                self.assertTrue(len(runtime.hermes_tools_snapshot()) >= 1)
                self.assertIn("model_name", runtime.model_info())
                self.assertTrue(runtime.user_name())


if __name__ == "__main__":
    unittest.main()
