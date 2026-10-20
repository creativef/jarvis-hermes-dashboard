"""api_backend: event mapping, approval forwarding, and the safety rules."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import api_backend

EVENTS = [
    {"event": "tool.started", "tool": "terminal", "preview": "rm -rf /tmp/x"},
    {"event": "approval.request", "request_id": "req1", "description": "recursive delete",
     "command": "rm -rf /tmp/x"},
    {"event": "approval.responded", "request_id": "req1", "choice": "once"},
    {"event": "tool.completed", "tool": "terminal", "error": False},
    {"event": "message.delta", "delta": "Done."},
    {"event": "run.completed", "output": "Done.",
     "usage": {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}},
]


class Fake(BaseHTTPRequestHandler):
    approvals = []
    stop_calls = []
    run_bodies = []
    events = EVENTS
    refuse_sessions = False

    def log_message(self, *a):
        pass

    def _auth(self):
        return self.headers.get("Authorization") == "Bearer secret"

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"status":"ok"}'); return
        if not self._auth():
            self.send_response(401); self.end_headers(); return
        if self.path.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            for ev in type(self).events:
                self.wfile.write(f"event: {ev['event']}\ndata: {json.dumps(ev)}\n\n".encode())
                self.wfile.flush()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if not self._auth():
            self.send_response(401); self.end_headers(); return
        if self.path == "/v1/runs":
            type(self).run_bodies.append(body)
            if type(self).refuse_sessions and "session_id" in body:
                self.send_response(409); self.send_header("Content-Length", "0"); self.end_headers(); return
            out = {"run_id": "run_abc123", "status": "started"}
        elif self.path.endswith("/approval"):
            type(self).approvals.append(body); out = {"resolved": 1, "choice": body["choice"]}
        elif self.path.endswith("/stop"):
            type(self).stop_calls.append(self.path); out = {"ok": True}
        else:
            self.send_response(404); self.end_headers(); return
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)


class ApiBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Fake.approvals.clear(); Fake.stop_calls.clear(); Fake.run_bodies.clear(); Fake.events = EVENTS
        Fake.refuse_sessions = False

    def _run(self, **kw):
        return list(api_backend.run("hi", kw.pop("session_id", None), "PROMPT", base=self.base, key="secret",
                                    idle_timeout=5, valid_session=lambda s: bool(s), **kw))

    def test_health(self):
        self.assertTrue(api_backend.healthy(self.base))
        self.assertFalse(api_backend.healthy("http://127.0.0.1:1"))

    def test_event_mapping(self):
        evs = self._run()
        kinds = [e["t"] for e in evs]
        self.assertEqual(kinds, ["status", "tool", "approval", "approval_done", "tool", "latency",
                                 "delta", "usage", "complete"])
        appr = next(e for e in evs if e["t"] == "approval")
        self.assertEqual((appr["run_id"], appr["request_id"], appr["risk"]), ("run_abc123", "req1", "high"))
        done = evs[-1]
        self.assertEqual(done["t"], "complete")
        self.assertEqual(done["session_id"], "run_abc123")      # fresh session → run id
        # persona goes as Hermes `instructions`; the saved user turn is only what was said
        self.assertEqual(Fake.run_bodies[0]["input"], "hi")
        self.assertEqual(Fake.run_bodies[0]["instructions"], "PROMPT")

    def test_resumes_given_session(self):
        evs = self._run(session_id="20261015_171425_cfb3ae")
        self.assertEqual(evs[-1]["session_id"], "20261015_171425_cfb3ae")
        self.assertEqual(Fake.run_bodies[0]["session_id"], "20261015_171425_cfb3ae")

    def test_session_refused_starts_a_fresh_thread(self):
        Fake.refuse_sessions = True
        evs = self._run(session_id="20261015_171425_cfb3ae")
        self.assertEqual(len(Fake.run_bodies), 2)
        self.assertNotIn("session_id", Fake.run_bodies[1])
        self.assertTrue(any(e["t"] == "note" and "fresh" in e["message"] for e in evs))
        self.assertEqual(evs[-1]["t"], "complete")
        self.assertEqual(evs[-1]["session_id"], "run_abc123")

    def test_bypass_auto_approves_and_logs(self):
        evs = self._run(auto_approve=True)
        self.assertNotIn("approval", [e["t"] for e in evs])
        self.assertTrue(any(e["t"] == "note" and "auto-approved" in e["message"] for e in evs))
        self.assertEqual(Fake.approvals, [{"choice": "once", "request_id": "req1"}])

    def test_only_once_or_deny_are_forwarded(self):
        for bad in ("always", "session", "ALWAYS ", "", None, "yes"):
            ok, _ = api_backend.resolve_approval(self.base, "secret", "run_abc123", "r", bad)
            self.assertFalse(ok, bad)
        self.assertEqual(Fake.approvals, [])                   # nothing leaked through
        ok, res = api_backend.resolve_approval(self.base, "secret", "run_abc123", "req1", "deny")
        self.assertTrue(ok); self.assertEqual(res["choice"], "deny")
        ok, _ = api_backend.resolve_approval(self.base, "secret", "run_abc123", "req1", " Once ")
        self.assertTrue(ok)

    def test_rejects_malicious_run_id(self):
        ok, _ = api_backend.resolve_approval(self.base, "secret", "../../etc", "r", "once")
        self.assertFalse(ok)

    def test_wrong_key_is_a_clean_error(self):
        evs = list(api_backend.run("hi", None, "P", base=self.base, key="nope", idle_timeout=5))
        self.assertEqual(evs[-1]["t"], "error")
        self.assertIn("401", evs[-1]["message"])

    def test_failed_run_reports_error(self):
        Fake.events = [{"event": "run.failed", "error": "boom"}]
        evs = self._run()
        self.assertEqual(evs[-1]["t"], "error"); self.assertIn("boom", evs[-1]["message"])

    def test_stream_without_completion_is_an_error(self):
        Fake.events = [{"event": "message.delta", "delta": "x"}]
        self.assertEqual(self._run()[-1]["t"], "error")

    def test_risk_tiers(self):
        self.assertEqual(api_backend.classify("recursive delete", "rm -rf x"), "high")
        self.assertEqual(api_backend.classify("send an email", ""), "high")
        self.assertEqual(api_backend.classify("install package", "pip install requests"), "normal")


if __name__ == "__main__":
    unittest.main()
