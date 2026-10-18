"""Unit and HTTP tests for Track 3: Inbox, Brain linking, Risk-Tier Approvals, Jobs & Activity."""
import base64
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

import api_backend
import brain
import commands
import server


class InboxBrainTests(unittest.TestCase):
    def setUp(self):
        self._root = brain.ROOT
        self.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = pathlib.Path(self.tmp.name)
        (brain.ROOT / "Atlas.md").write_text("# Atlas\n\nHub note.\n", encoding="utf-8")

    def tearDown(self):
        brain.ROOT = self._root
        self.tmp.cleanup()

    def test_save_quick_note_links_into_brain_graph(self):
        item, err = brain.inbox_save({
            "name": "Hoodie Supplier Quote",
            "content": "Heavyweight hoodie margin is 42% after shipping. See [[pricing]].",
            "kind": "note",
        })
        self.assertIsNone(err)
        assert item is not None
        self.assertEqual(item["kind"], "note")
        self.assertTrue((brain.ROOT / item["path"]).is_file())
        self.assertTrue((brain.ROOT / item["note_path"]).is_file())

        # Companion markdown note must be discoverable in brain.note() and brain.graph()
        note = brain.note(item["note_id"])
        self.assertIsNotNone(note)
        assert note is not None
        self.assertIn("[[Atlas]]", note["text"])
        self.assertIn("Heavyweight hoodie", note["text"])

        g = brain.graph()
        node_ids = {n["id"]: n for n in g["nodes"]}
        self.assertIn(item["note_id"], node_ids)
        self.assertEqual(node_ids[item["note_id"]]["type"], "inbox")
        # Linked to Atlas hub
        linked_pairs = {(e["source"], e["target"]) for e in g["links"]} | {(e["target"], e["source"]) for e in g["links"]}
        self.assertIn((item["note_id"], "Atlas"), linked_pairs)

    def test_markdown_drop_is_one_graph_node(self):
        b64 = base64.b64encode(b"# Plan\n\nSee [[Atlas]].\n").decode()
        item, err = brain.inbox_save({"name": "plan.md", "data_base64": b64})
        self.assertIsNone(err)
        assert item is not None
        self.assertTrue((brain.ROOT / item["path"]).is_file())            # original kept on disk
        ids = {n["id"] for n in brain.graph()["nodes"]}
        self.assertIn(item["note_id"], ids)
        self.assertFalse(any(i.endswith("-source") for i in ids))         # but not drawn twice

    def test_save_csv_base64_and_auto_triage(self):
        csv_bytes = b"idea,spend,ctr,purchases\nDad Hoodie,12.50,1.4,3\n"
        b64 = "data:text/csv;base64," + base64.b64encode(csv_bytes).decode()
        item, err = brain.inbox_save({"name": "batch1-roas.csv", "data_base64": b64})
        self.assertIsNone(err)
        assert item is not None
        self.assertEqual(item["kind"], "csv")
        self.assertEqual(item["triage"]["department"], "marketing")
        self.assertEqual(item["triage"]["team"], "analytics")

        note = brain.note(item["note_id"])
        assert note is not None
        self.assertIn("CSV structure", note["text"])
        self.assertIn("idea,spend,ctr,purchases", note["text"])

    def test_rejects_executable_and_path_traversal_filenames(self):
        for bad in ("exploit.sh", "../../etc/passwd.py", "run.exe", "script.js"):
            item, err = brain.inbox_save({"name": bad, "content": "echo hi"})
            self.assertIsNone(item, bad)
            self.assertIsNotNone(err, bad)

        # Traversal prefix with allowed extension is stripped to basename inside inbox/
        item, err = brain.inbox_save({"name": "../../secret/notes.txt", "content": "safe"})
        self.assertIsNone(err)
        assert item is not None
        self.assertEqual(item["name"], "notes.txt")
        self.assertTrue((brain.ROOT / item["path"]).resolve().is_relative_to(brain.inbox_dir().resolve()))

    def test_file_and_discard_actions(self):
        item, err = brain.inbox_save({"name": "idea.txt", "content": "New journal idea"})
        self.assertIsNone(err)
        assert item is not None
        iid = item["id"]

        filed, err = brain.inbox_action({"id": iid, "action": "file", "department": "design-content", "team": "pod-design"})
        self.assertIsNone(err)
        assert filed is not None
        self.assertEqual(filed["status"], "filed")
        self.assertEqual(filed["triage"]["department"], "design-content")

        gone, err = brain.inbox_action({"id": iid, "action": "discard"})
        self.assertIsNone(err)
        assert gone is not None
        self.assertTrue(gone["discarded"])
        self.assertEqual(brain.inbox_list()["items"], [])


class RiskTierApprovalTests(unittest.TestCase):
    def test_classify_tier_low_medium_high(self):
        low = api_backend.classify_tier("list files", "ls -la")
        self.assertEqual(low["tier"], "low")
        self.assertIn("Read-only", low["reason"])

        med = api_backend.classify_tier("install package", "pip install rich")
        self.assertEqual(med["tier"], "medium")
        self.assertIn("Modifies local", med["reason"])

        high_del = api_backend.classify_tier("delete temp folder", "rm -rf /tmp/build")
        self.assertEqual(high_del["tier"], "high")
        self.assertIn("Destructive", high_del["reason"])

        high_send = api_backend.classify_tier("send campaign email", "himalaya send")
        self.assertEqual(high_send["tier"], "high")
        self.assertIn("Sends", high_send["reason"])

        high_spend = api_backend.classify_tier("purchase domain", "curl -X POST https://api/buy")
        self.assertEqual(high_spend["tier"], "high")
        self.assertIn("Spends", high_spend["reason"])


class ServerInboxAndActivityEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_root = brain.ROOT
        cls.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = pathlib.Path(cls.tmp.name)
        (brain.ROOT / "Atlas.md").write_text("# Atlas\n", encoding="utf-8")
        (brain.ROOT / "pod-idea-queue.md").write_text("# POD Queue\n- Dad Journal (82/100)\n", encoding="utf-8")

        cls.srv = server.JarvisServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        cls._orig_port = server.PORT
        server.PORT = cls.port
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        server.PORT = cls._orig_port
        brain.ROOT = cls._orig_root
        cls.tmp.cleanup()

    def _req(self, path, method="GET", body=None, token=True):
        headers = {"Origin": self.base}
        if token:
            headers["X-Jarvis-Token"] = server.API_TOKEN
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8"))

    def test_inbox_requires_token(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._req("/api/inbox", token=False)
        self.assertEqual(ctx.exception.code, 401)

    def test_post_and_get_inbox_and_activity(self):
        code, res = self._req("/api/inbox", method="POST", body={
            "name": "q4-ideas.csv",
            "content": "idea,score\nTeacher Mug,78\n",
            "kind": "csv",
        })
        self.assertEqual(code, 200)
        self.assertTrue(res["ok"])
        item = res["item"]
        self.assertEqual(item["kind"], "csv")

        code, listing = self._req("/api/inbox")
        self.assertEqual(code, 200)
        self.assertEqual(len(listing["items"]), 1)
        self.assertEqual(listing["items"][0]["id"], item["id"])

        with mock.patch.object(commands, "HANDOFF_DIR", pathlib.Path(self.tmp.name)):
            code, act = self._req("/api/activity")
        self.assertEqual(code, 200)
        self.assertEqual(len(act["inbox"]), 1)
        self.assertTrue(any(p["id"] == "pod-idea-queue" for p in act["pod"]))

    def test_themes_css_keeps_orb_words_hidden_and_bound_ids_exist(self):
        themes_css = (server.UI / "themes.css").read_text(encoding="utf-8")
        self.assertIn(".status,.stbrand,.strun,.stword{display:none!important}", themes_css)
        html = (server.UI / "index.html").read_text(encoding="utf-8")
        for req_id in (
            "input", "run", "mic", "mute", "clearBtn", "settingsBtn", "cmds", "log",
            "response", "rtag", "stword", "strun", "tip", "toolsList",
            "sy-gw", "sy-brain", "sy-voice", "sy-profile", "sy-runtime", "sy-clock",
            "top-gw", "top-profile", "top-voice", "showCommands", "missionBtn", "live",
            "navInbox", "navJobs", "inboxOverlay", "jobsOverlay", "brSearch", "brOutline",
            "apTier", "apReason", "apRing",
        ):
            self.assertIn(f'id="{req_id}"', html, f"missing bound id {req_id}")


if __name__ == "__main__":
    unittest.main()
