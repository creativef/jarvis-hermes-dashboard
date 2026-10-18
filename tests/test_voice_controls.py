"""Things you say about the conversation are handled locally, and voice/speed are settings."""
import pathlib
import tempfile
import unittest
from unittest import mock

import commands
import voice


class VoiceControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = mock.patch.object(commands, "STATE_FILE", pathlib.Path(self.tmp.name) / "state.json")
        self.state.start()
        self.saved = (voice.KOKORO_VOICE, voice.KOKORO_SPEED)

    def tearDown(self):
        self.state.stop()
        voice.KOKORO_VOICE, voice.KOKORO_SPEED = self.saved
        self.tmp.cleanup()

    def test_stop_is_silent_and_needs_no_model(self):
        res = commands.handle("Atlas, stop.")
        self.assertIsNone(res["message"])
        self.assertEqual(res["reply"], "")

    def test_repeat_says_the_last_answer_again(self):
        self.assertIn("haven't said", commands.handle("repeat that")["reply"])
        commands.record_turn("what time is it", "It's ten past nine.")
        self.assertEqual(commands.handle("say that again")["reply"], "It's ten past nine.")

    def test_slower_and_faster_change_and_persist_speed(self):
        voice.KOKORO_SPEED = 1.0
        self.assertEqual(commands.handle("slower")["reply"], "Slower it is.")
        self.assertAlmostEqual(voice.KOKORO_SPEED, 0.9)
        self.assertAlmostEqual(commands.get_settings()["voice_speed"], 0.9)
        commands.handle("faster"); commands.handle("faster")
        self.assertAlmostEqual(voice.KOKORO_SPEED, 1.1)
        voice.KOKORO_SPEED = voice.SPEED_MIN
        self.assertIn("as slow as I go", commands.handle("slow down")["reply"])

    def test_new_topic_starts_fresh_locally(self):
        res = commands.handle("new topic")
        self.assertTrue(res["fresh"])
        self.assertIsNone(res["message"])

    def test_voice_settings_are_validated(self):
        ok, err = commands.set_settings({"voice": "bf_emma", "voice_speed": 1.2})
        self.assertIsNone(err)
        voice.apply_settings(ok)
        self.assertEqual((voice.KOKORO_VOICE, voice.KOKORO_SPEED), ("bf_emma", 1.2))
        self.assertIsNotNone(commands.set_settings({"voice": "../etc"})[1])
        self.assertIsNotNone(commands.set_settings({"voice_speed": 3})[1])


if __name__ == "__main__":
    unittest.main()
