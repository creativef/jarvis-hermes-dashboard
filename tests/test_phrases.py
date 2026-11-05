import json
import pathlib
import tempfile
import unittest
from unittest import mock

import phrases


class PhraseFileTests(unittest.TestCase):
    """The real phrases.json must stay loadable and cover every group the code asks for."""

    def test_shipped_file_has_every_group(self):
        data = phrases.all_lines()
        for group in ("ack", "ack_question", "ack_task", "ack_lookup", "long_wait", "longer_wait",
                      "handoff", "job_done", "job_failed", "didnt_catch",
                      "greet_late", "greet_morning", "greet_afternoon", "greet_evening"):
            self.assertTrue(data.get(group), group)

    def test_lines_are_plain_speech(self):
        # the UI strips * _ # > ` before speaking, so a line with them wouldn't hit the voice cache
        for group, lines in phrases.all_lines().items():
            for line in lines:
                self.assertNotRegex(line, r"[*_#>`]", f"{group}: {line}")


class DealingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.file = pathlib.Path(self.dir.name) / "phrases.json"
        self.write({"ack": ["a", "b", "c"], "retired": []})
        patches = [mock.patch.object(phrases, "FILE", self.file),
                   mock.patch.dict(phrases._data, {"mtime": None, "lines": {}}),
                   mock.patch.object(phrases, "_decks", {}), mock.patch.object(phrases, "_last", {}),
                   mock.patch.object(phrases, "on_change", None)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.dir.cleanup)

    def write(self, data, bump=0):
        self.file.write_text(json.dumps(data), encoding="utf-8")
        if bump:                                   # mtime resolution: make the change visible
            st = self.file.stat()
            import os
            os.utime(self.file, (st.st_atime, st.st_mtime + bump))

    def test_every_line_plays_before_any_repeats_and_never_twice_running(self):
        said = [phrases.pick("ack") for _ in range(30)]
        for i in range(0, 30, 3):
            self.assertEqual(sorted(said[i:i + 3]), ["a", "b", "c"])
        self.assertTrue(all(x != y for x, y in zip(said, said[1:])))

    def test_retired_lines_are_never_said_and_edits_are_picked_up(self):
        phrases.pick("ack")
        self.write({"ack": ["a", "b", "new"], "retired": ["a", "b"]}, bump=5)
        self.assertEqual({phrases.pick("ack") for _ in range(5)}, {"new"})

    def test_a_broken_edit_keeps_the_last_good_lines(self):
        self.assertIn(phrases.pick("ack"), {"a", "b", "c"})
        self.file.write_text("{ not json", encoding="utf-8")
        self.assertIn(phrases.pick("ack"), {"a", "b", "c"})

    def test_empty_group_gives_the_fallback(self):
        self.assertEqual(phrases.pick("nope", "fallback"), "fallback")

    def test_reload_tells_the_server_to_record_new_lines(self):
        calls = []
        phrases.pick("ack")
        with mock.patch.object(phrases, "on_change", lambda: calls.append(1)):
            self.write({"ack": ["x"]}, bump=5)
            phrases.pick("ack")
        self.assertEqual(calls, [1])


class AckChoiceTests(unittest.TestCase):
    def group_for(self, message):
        seen = {}
        with mock.patch.object(phrases, "SILENCE", 0), \
             mock.patch.object(phrases, "pick", side_effect=lambda g, f="": seen.setdefault("g", g)):
            phrases.ack(message)
        return seen["g"]

    def test_groups(self):
        self.assertEqual(self.group_for("What's on my calendar?"), "ack_question")
        self.assertEqual(self.group_for("Atlas, could you tell me the time in Tokyo"), "ack_question")
        self.assertEqual(self.group_for("Can you draft a reply to Sarah"), "ack_task")
        self.assertEqual(self.group_for("Hey Atlas, send the invoice"), "ack_task")
        self.assertEqual(self.group_for("Look up flights to Stockholm"), "ack_lookup")
        self.assertEqual(self.group_for("Could you research hoodie trends"), "ack_lookup")
        self.assertEqual(self.group_for("explain photosynthesis"), "ack")
        self.assertEqual(self.group_for("settings are weird today"), "ack")   # "set" isn't "settings"

    def test_sometimes_says_nothing(self):
        with mock.patch.object(phrases, "SILENCE", 1):
            self.assertEqual(phrases.ack("What time is it?"), "")


class ModelSpeechTests(unittest.TestCase):
    """Step 7: what the model itself says is checked, not just requested."""

    def test_tidy_drops_sir_and_banned_openers_only(self):
        cases = {
            "Yes, sir.": "Yes.",
            "Sir, the build passed.": "The build passed.",
            "Done sir!": "Done!",
            "Certainly, here it is.": "Here it is.",
            "Great question!": "",
            "One moment, sir.": "",
            "Happy to help — the file is saved.": "The file is saved.",
            "Absolutely not.": "Absolutely not.",               # not an opener: meaning kept
            "Sir Isaac Newton was right.": "Sir Isaac Newton was right.",
            "It is certainly fine.": "It is certainly fine.",
        }
        for said, heard in cases.items():
            self.assertEqual(phrases.tidy(said), heard, said)

    def test_spoken_sentences_are_tidied(self):
        import runtime
        sb = runtime.SentenceBuffer()
        out = sb.feed("Certainly, sir. The report is ready, sir. ") + sb.flush()
        self.assertEqual([t for _, t in out], ["The report is ready."])
        self.assertEqual([i for i, _ in out], [0])               # an emptied sentence takes no index

    def test_freshness_lists_bans_and_recent_openers(self):
        history = [{"assistant": "ATLAS: Sorted. The invoice went out."},
                   {"assistant": "Right then, three calls today.\n---\n- a\n- b"}]
        block = phrases.freshness(history)
        self.assertIn('"Great question"', block)
        self.assertIn('"Sorted. The invoice went out..."', block)
        self.assertIn('"Right then, three calls today..."', block)
        self.assertNotIn("ATLAS:", block)


if __name__ == "__main__":
    unittest.main()
