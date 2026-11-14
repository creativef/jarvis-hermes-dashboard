"""How much Atlas says and how he words it: the talk setting, lines with slots, the phrase
library changed by voice, the greeting's news, and the quick replies that used to be fixed text.

    python3 -m unittest tests.test_voice_vocabulary
"""
import datetime
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import brain
import commands
import phrases
import server


class Fixture(unittest.TestCase):
    """A private state.json, phrases.json, brain and handoff folder for each test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.d = pathlib.Path(self.tmp.name)
        lib = d / "phrases.json"
        lib.write_text(phrases.FILE.read_text(encoding="utf-8"), encoding="utf-8")
        (d / "handoff").mkdir()
        self._brain = brain.ROOT
        brain.ROOT = d / "brain"
        self.patches = [mock.patch.object(commands, "STATE_FILE", d / "state.json"),
                        mock.patch.object(commands, "HANDOFF_DIR", d / "handoff"),
                        mock.patch.object(phrases, "FILE", lib),
                        mock.patch.object(phrases, "CANDIDATES", d / "candidates.json"),
                        mock.patch.object(phrases, "USAGE", d / "usage.json"),
                        mock.patch.dict(phrases._data, {"mtime": None, "lines": {}}),
                        mock.patch.object(phrases, "last_spoken", "")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        brain.ROOT = self._brain
        self.tmp.cleanup()


class PersonaTests(Fixture):
    def test_the_persona_no_longer_orders_one_liners(self):
        text = server.persona()
        for gone in ("One or two sentences", "Three at the absolute most", "in one line", "four words", "stay concise"):
            self.assertNotIn(gone, text)
        for kept in ("## How much to say", "## Conversation", "Hand it back", "must still stand on its own"):
            self.assertIn(kept, text)

    def test_talk_setting_by_voice_changes_the_persona_and_is_saved(self):
        normal = server.persona()
        r = commands.fast_path("Atlas, be more chatty")
        self.assertIn(r["reply"], phrases.lines("talk_chatty"))
        self.assertEqual(commands.get_settings()["talk"], "chatty")
        self.assertIn("talk things through", server.persona())
        self.assertEqual(server.persona(), server.persona())            # stable turn to turn: prompt cache
        commands.fast_path("keep it brief")
        self.assertIn("short answers", server.persona())
        commands.fast_path("back to normal")
        self.assertEqual(server.persona(), normal)
        self.assertIsNotNone(commands.set_settings({"talk": "shouty"})[1])

    def test_a_tone_overlay_is_not_told_to_stay_concise(self):
        commands.handle("/personality warmer and chattier")
        self.assertIn("warmer and chattier", commands.context_block())
        self.assertNotIn("concise", commands.context_block())


class QuickReplyTests(Fixture):
    def test_quick_replies_come_from_the_library_in_character(self):
        self.assertRegex(commands.fast_path("what time is it")["reply"], r"\d\d:\d\d")
        who = commands.fast_path("who are you")["reply"]
        self.assertIn("Atlas", who)
        self.assertNotIn("Hermes", who)                                  # the persona forbids it
        self.assertNotIn("{", who)
        self.assertIn(commands.fast_path("clear")["reply"], phrases.lines("cleared"))
        self.assertIn(commands.fast_path("new topic")["reply"], phrases.lines("fresh"))

    def test_a_line_with_a_broken_slot_falls_back(self):
        with mock.patch.object(phrases, "pick", return_value="It's {tme}."):
            self.assertEqual(phrases.say("time", "It's {time}.", time="09:00", day="Monday"), "It's 09:00.")


class LibraryByVoiceTests(Fixture):
    def test_dont_say_that_again_retires_the_line_just_used(self):
        phrases.last_spoken = "Let me consult the oracle."
        r = commands.fast_path("don't say that again")
        self.assertIn("Let me consult the oracle", r["reply"])
        self.assertNotIn("Let me consult the oracle.", phrases.lines("ack_question"))
        self.assertIn("Let me consult the oracle.", json.loads(phrases.FILE.read_text())["retired"])
        phrases.last_spoken = "something the model said"                # not a stock line: nothing to retire
        self.assertIn("nothing to retire", commands.fast_path("stop saying that")["reply"])

    def test_new_lines_are_checked_then_kept_or_binned(self):
        phrases.CANDIDATES.write_text(json.dumps({
            "ack": ["Give me a moment to think.", "Right then.", "**bold** is not speech", "x" * 200],
            "added": ["Popped onto {note}.", "Filed under {nonsense}."],
            "never_say": ["Certainly not"], "made_up_group": ["hello"]}))
        self.assertEqual(phrases.candidates(), {"ack": ["Give me a moment to think."], "added": ["Popped onto {note}."]})
        self.assertIn("2 new lines", commands.fast_path("what are the new lines")["reply"])
        self.assertIn("2 new lines", commands.fast_path("keep them")["reply"])
        self.assertIn("Give me a moment to think.", phrases.lines("ack"))
        self.assertFalse(phrases.CANDIDATES.exists())
        self.assertIsNone(commands.fast_path("keep them"))               # nothing waiting: an ordinary sentence again
        phrases.CANDIDATES.write_text(json.dumps({"ack": ["Another one for the pile."]}))
        commands.fast_path("bin them")
        self.assertNotIn("Another one for the pile.", phrases.lines("ack"))

    def test_a_retired_line_cannot_come_back_as_new(self):
        phrases.retire("Let me consult the oracle.")
        phrases.CANDIDATES.write_text(json.dumps({"ack_question": ["Let me consult the oracle.", "One for the detectives."]}))
        self.assertEqual(phrases.candidates(), {"ack_question": ["One for the detectives."]})

    def test_spoken_stock_lines_are_counted_once_each_time(self):
        line = phrases.lines("long_wait")[0]
        other = phrases.lines("ack_task")[0]
        phrases.heard(line); phrases.heard(line)          # the page repeats it on every turn until a new one is said
        phrases.heard(other); phrases.heard(line)
        phrases.heard("something the model said")         # not a stock line: not counted
        self.assertEqual(phrases.usage(), {line: 2, other: 1})
        r = commands.fast_path("which lines do you say most")
        self.assertIn(line.rstrip(".!?"), r["reply"])
        self.assertIn("2 times", r["reply"])

    def test_freshen_up_sends_a_helper_to_write_candidates(self):
        from tools import handoff
        with mock.patch.object(handoff, "launch", return_value="ab12cd34") as launch:
            r = commands.fast_path("freshen up your lines")
        self.assertIn(str(phrases.CANDIDATES), launch.call_args.args[0])
        self.assertIn("{time}", launch.call_args.args[0])                # told to keep the slots
        self.assertIn("helper", r["reply"])


class GreetingNewsTests(Fixture):
    def test_the_greeting_mentions_what_happened_while_he_was_away(self):
        now = datetime.datetime(2026, 11, 14, 8, 0)
        self.assertNotIn("helper", server.build_greeting(now)["text"])   # nothing happened: just the hello
        job = {"id": "a1", "status": "done", "mission": "m", "result": "ok", "started": 1.0, "finished": now.timestamp() - 3600}
        (self.d / "handoff" / "a1.json").write_text(json.dumps(job))
        (self.d / "handoff" / "a2.json").write_text(json.dumps(dict(job, id="a2", status="failed")))
        (self.d / "handoff" / "old.json").write_text(json.dumps(dict(job, id="old", finished=now.timestamp() - 3 * 86400)))
        (self.d / "handoff" / "q.json").write_text(json.dumps(dict(job, id="q", quiet=True)))
        brain.inbox_save({"name": "idea.txt", "content": "a mug about Mondays"})
        text = server.build_greeting(now)["text"]
        self.assertIn("2 helper jobs finished while you were away, 1 of them with a problem", text)
        self.assertIn("one thing is waiting in the inbox", text)
        self.assertTrue(text.startswith("Good morning"))


class HelperResultTests(unittest.TestCase):
    def test_helpers_are_asked_for_a_spoken_summary_and_kept_detail(self):
        from tools import handoff
        rules = handoff.rules("Mr Thompson")
        self.assertIn("two to four plain spoken sentences", rules)
        self.assertIn("---", rules)
        self.assertNotIn("one or two", rules)


if __name__ == "__main__":
    unittest.main()
