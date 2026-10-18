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


class CancelKeepsSessionTests(unittest.TestCase):
    def test_cancel_does_not_forget_the_conversation(self):
        import io
        from unittest import mock
        sid = "20261018_120000_keepme"
        saved = server.SESSION["id"]
        server.SESSION["id"] = sid
        try:
            h = server.Handler.__new__(server.Handler)
            h.path = "/api/cancel"
            h.headers = {"Host": f"127.0.0.1:{server.PORT}", "Origin": f"http://127.0.0.1:{server.PORT}",
                         "X-Jarvis-Token": server.API_TOKEN, "Content-Type": "application/json",
                         "Content-Length": "2"}
            h.rfile, h.wfile = io.BytesIO(b"{}"), io.BytesIO()
            h.client_address = ("127.0.0.1", 0)
            with mock.patch.object(server.runtime, "cancel_active", return_value=True), \
                 mock.patch.object(server.commands, "set_session") as set_session, \
                 mock.patch.object(h, "_json") as reply:
                h.do_POST()
            reply.assert_called_once()
            self.assertEqual(server.SESSION["id"], sid)
            set_session.assert_not_called()
        finally:
            server.SESSION["id"] = saved


if __name__ == "__main__":
    unittest.main()
