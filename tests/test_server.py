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
                # an empty assignment means UNSET: it must not shadow a real value below,
                # which is what let a stale empty key win and a fresh one be appended daily
                "LATEKEY=\n"
                "LATEKEY=real-value\n"
            )
            keys = ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "HERMES_PROFILE", "BLANK", "LATEKEY")
            with _del_env(*keys):
                server._load_dotenv(env)
                self.assertEqual(os.environ["ELEVENLABS_API_KEY"], "abc123")
                self.assertEqual(os.environ["ELEVENLABS_VOICE_ID"], "quoted")
                self.assertEqual(os.environ["HERMES_PROFILE"], "work")
                self.assertNotIn("BLANK", os.environ)
                self.assertEqual(os.environ["LATEKEY"], "real-value")


class AttachmentPruneTests(unittest.TestCase):
    def test_old_day_folders_are_pruned_and_recent_ones_kept(self):
        from unittest import mock
        import datetime
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            today = datetime.date.today().isoformat()
            old = (datetime.date.today() - datetime.timedelta(days=server.ATTACH_KEEP_DAYS + 5)).isoformat()
            for name in (today, old):
                d = root / name
                d.mkdir(parents=True)
                (d / "shot.png").write_text("x")
            with mock.patch.object(server, "ATTACH_ROOT", root):
                server._attach_prune()
            self.assertTrue((root / today / "shot.png").is_file())
            self.assertFalse((root / old).exists())


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

    def test_one_error_keeps_the_conversation(self):
        # A 429, a provider timeout or a 120s idle stop is not a broken conversation.
        saved, streak = server.SESSION["id"], server.ERROR_STREAK["n"]
        server.SESSION["id"] = "20261020_120000_flaky"
        server.ERROR_STREAK["n"] = 0
        try:
            set_session = self._stream([{"t": "error", "message": "429 from the provider"}])
            self.assertEqual(server.SESSION["id"], "20261020_120000_flaky")
            set_session.assert_not_called()
        finally:
            server.SESSION["id"], server.ERROR_STREAK["n"] = saved, streak

    def test_two_errors_in_a_row_drop_the_session(self):
        saved, streak = server.SESSION["id"], server.ERROR_STREAK["n"]
        server.SESSION["id"] = "20261020_120000_broken"
        server.ERROR_STREAK["n"] = 1                 # the previous turn already failed
        try:
            set_session = self._stream([{"t": "error", "message": "boom"}])
            self.assertIsNone(server.SESSION["id"])
            set_session.assert_called_once_with(None)
        finally:
            server.SESSION["id"], server.ERROR_STREAK["n"] = saved, streak

    def test_a_fresh_start_is_saved_not_just_held_in_memory(self):
        # Clearing only the in-memory session meant a failed first turn plus a restart
        # resumed the very thread you asked to leave.
        import io
        from unittest import mock
        saved = server.SESSION["id"]
        server.SESSION["id"] = "20261020_120000_oldone"
        h = server.Handler.__new__(server.Handler)
        h.request_version, h.requestline, h.command = "HTTP/1.1", "", "POST"
        h.client_address = ("127.0.0.1", 0)
        h.wfile = io.BytesIO()
        try:
            with mock.patch.object(server.runtime, "run", return_value=iter([{"t": "error", "message": "429"}])), \
                 mock.patch.object(server.commands, "handle", return_value=None), \
                 mock.patch.object(server.commands, "clear_history"), \
                 mock.patch.object(server.commands, "set_session") as set_session:
                h._stream_run(b'{"message": "hello", "fresh": true}')
            set_session.assert_called_with(None)
            self.assertIsNone(server.SESSION["id"])
        finally:
            server.SESSION["id"] = saved

    def test_a_completed_turn_clears_the_error_streak(self):
        saved, streak = server.SESSION["id"], server.ERROR_STREAK["n"]
        server.ERROR_STREAK["n"] = 1
        try:
            self._stream([{"t": "complete", "session_id": "20261020_120000_ok"}])
            self.assertEqual(server.ERROR_STREAK["n"], 0)
        finally:
            server.SESSION["id"], server.ERROR_STREAK["n"] = saved, streak


    def test_a_refused_session_is_dropped_at_once(self):
        # The gateway refusing the conversation (a 409 on resume) is PERMANENT, unlike a
        # 429 or an idle stop: drop it now rather than resuming a refused thread every turn.
        saved, streak = server.SESSION["id"], server.ERROR_STREAK["n"]
        server.SESSION["id"] = "20261020_120000_refused"
        server.ERROR_STREAK["n"] = 0
        try:
            set_session = self._stream([{"t": "note", "drop_session": True,
                                         "message": "Started a fresh Hermes thread on the API server."}])
            self.assertIsNone(server.SESSION["id"])
            set_session.assert_called_once_with(None)
            self.assertEqual(server.ERROR_STREAK["n"], 0)   # not counted as a strike
        finally:
            server.SESSION["id"], server.ERROR_STREAK["n"] = saved, streak


if __name__ == "__main__":
    unittest.main()
