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


class RejectionTests(unittest.TestCase):
    def _post(self, path, body, token=True):
        import io
        h = server.Handler.__new__(server.Handler)
        h.request_version, h.requestline, h.command = "HTTP/1.1", "", "POST"
        h.path, h.client_address = path, ("127.0.0.1", 0)
        h.headers = {"Host": f"127.0.0.1:{server.PORT}", "Origin": f"http://127.0.0.1:{server.PORT}",
                     "X-Jarvis-Token": server.API_TOKEN if token else "nope",
                     "Content-Type": "application/json", "Content-Length": str(len(body))}
        h.rfile, h.wfile = io.BytesIO(body), io.BytesIO()
        h.close_connection = False
        h.do_POST()
        return h, h.wfile.getvalue().decode()

    def test_rejection_closes_the_connection(self):
        # the body is never read on a 401, so the connection must not be reused
        h, out = self._post("/api/run", b'{"message":"x"}', token=False)
        self.assertIn(" 401 ", out.splitlines()[0])
        self.assertTrue(h.close_connection)
        self.assertIn("Connection: close", out)

    def test_non_object_json_gets_a_400(self):
        for path in ("/api/run", "/api/approval", "/api/speak", "/api/settings", "/api/inbox"):
            _, out = self._post(path, b"[1, 2]")
            self.assertIn(" 400 ", out.splitlines()[0], path)


class StreamKeepsSessionTests(unittest.TestCase):
    def _stream(self, events):
        import io
        from unittest import mock
        h = server.Handler.__new__(server.Handler)
        h.request_version, h.requestline, h.command = "HTTP/1.1", "", "POST"
        h.client_address = ("127.0.0.1", 0)
        h.wfile = io.BytesIO()
        with mock.patch.object(server.runtime, "run", return_value=iter(events)), \
             mock.patch.object(server.commands, "handle", return_value=None), \
             mock.patch.object(server.commands, "set_session") as set_session:
            h._stream_run(b'{"message": "hello"}')
        return set_session

    def test_cancelled_turn_keeps_the_conversation(self):
        sid = "20261020_120000_keepme"
        saved = server.SESSION["id"]
        server.SESSION["id"] = sid
        try:
            set_session = self._stream([{"t": "ack"}, {"t": "cancelled", "message": "stopped"}])
            self.assertEqual(server.SESSION["id"], sid)
            set_session.assert_not_called()
        finally:
            server.SESSION["id"] = saved

    def test_error_turn_drops_the_session(self):
        saved = server.SESSION["id"]
        server.SESSION["id"] = "20261020_120000_broken"
        try:
            self._stream([{"t": "error", "message": "boom"}])
            self.assertIsNone(server.SESSION["id"])
        finally:
            server.SESSION["id"] = saved


if __name__ == "__main__":
    unittest.main()
