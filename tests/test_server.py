import contextlib
import os
import pathlib
import tempfile
import unittest

import server


@contextlib.contextmanager
def _del_env(*keys):
    saved = {k: os.environ.pop(k, None) for k in keys}
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class DotenvTests(unittest.TestCase):
    def test_parsing(self):
        with tempfile.TemporaryDirectory() as td:
            env = pathlib.Path(td) / ".env"
            env.write_text(
                'ELEVENLABS_API_KEY=abc123 # trailing note\n'
                'ELEVENLABS_VOICE_ID="quoted"\n'
                "export HERMES_PROFILE=work\n"
                "# full line comment\n"
                "BLANK=\n"
            )
            keys = ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "HERMES_PROFILE", "BLANK")
            with _del_env(*keys):
                server._load_dotenv(env)
                self.assertEqual(os.environ["ELEVENLABS_API_KEY"], "abc123")
                self.assertEqual(os.environ["ELEVENLABS_VOICE_ID"], "quoted")
                self.assertEqual(os.environ["HERMES_PROFILE"], "work")
                self.assertEqual(os.environ["BLANK"], "")


if __name__ == "__main__":
    unittest.main()
