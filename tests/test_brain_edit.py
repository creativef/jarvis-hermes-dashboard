"""Brain editing, linking, suggestions, spoken Brain intents and their HTTP routes.

Every test runs against a throwaway ATLAS_BRAIN folder; the real ~/Atlas is never touched.

    python3 -m unittest tests.test_brain_edit
"""
import json
import os
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import brain
import commands
import server


def _write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


class BrainFixture(unittest.TestCase):
    def setUp(self):
        self._root = brain.ROOT
        self.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = r = pathlib.Path(self.tmp.name)
        _write(r, "Atlas.md", "# Atlas\n\n[[finance]]\n")
        _write(r, "departments/finance/finance.md", "# Finance\n\nPart of [[Atlas]]. Teams: [[pricing]].\n")
        _write(r, "departments/finance/pricing/pricing.md", "# Pricing\n\nOur POD idea queue drives what we price.\n")
        _write(r, "departments/finance/finance-notebook.md", "# Finance notebook\n\n[[finance]]\n")
        _write(r, "commons/pod-idea-queue.md", "# POD idea queue\n\nScored ideas. See [[Atlas]].\n")

    def tearDown(self):
        brain.ROOT = self._root
        self.tmp.cleanup()


class FindNoteTests(BrainFixture):
    def test_spoken_phrases_resolve(self):
        self.assertEqual(brain.find_note("finance"), "finance")             # exact beats the notebook prefix
        self.assertEqual(brain.find_note("my pricing notes"), "pricing")
        self.assertEqual(brain.find_note("finance notebook"), "finance-notebook")
        self.assertEqual(brain.find_note("POD idea"), "pod-idea-queue")
        self.assertEqual(brain.find_note("the idea queue"), "pod-idea-queue")
        self.assertIsNone(brain.find_note("quarterly taxes"))
        self.assertIsNone(brain.find_note("queue idea", min_tier=2))         # words present, phrase is not


class EditTests(BrainFixture):
    def test_save_and_conflict(self):
        n = brain.note("pricing")
        res, err = brain.save_note("pricing", "# Pricing\n\nNew text.\n", n["mtime"])
        self.assertIsNone(err)
        self.assertIn("New text", res["text"])
        # saving against the old copy is refused instead of overwriting the newer file
        os.utime(brain.ROOT / "departments/finance/pricing/pricing.md", (1, n["mtime"] + 5))
        _, err = brain.save_note("pricing", "stale", n["mtime"])
        self.assertTrue(err.startswith("conflict"))
        _, err = brain.save_note("nope", "x")
        self.assertEqual(err, "note not found")

    def test_huge_notes_are_read_only(self):
        _write(brain.ROOT, "big.md", "x" * (brain._MAX_NOTE + 10) + " [[Atlas]]")
        self.assertFalse(brain.note("big")["editable"])
        _, err = brain.save_note("big", "short")
        self.assertIn("too large", err)
        self.assertEqual((brain.ROOT / "big.md").stat().st_size, brain._MAX_NOTE + 10 + len(" [[Atlas]]"))

    def test_create_note_placement_and_safety(self):
        res, err = brain.create_note("Shipping Cutoffs", near="pricing")
        self.assertIsNone(err)
        self.assertEqual(res["path"], "departments/finance/pricing/shipping-cutoffs.md")
        self.assertIn("[[pricing]]", res["text"])
        res, _ = brain.create_note("Loose Idea")
        self.assertEqual(res["path"], "notes/loose-idea.md")
        res, _ = brain.create_note("Budget Rules", near="finance")         # dept-level anchor: not a fake dept
        self.assertEqual(res["path"], "departments/finance/notes/budget-rules.md")
        for bad in ("../escape", "a/b", ".hidden", "", "x" * 81):
            self.assertIsNone(brain.create_note(bad)[0], bad)
        self.assertIsNotNone(brain.create_note("shipping cutoffs")[1])     # duplicate name
        g = brain.graph()
        self.assertIn("shipping-cutoffs", {n["id"] for n in g["nodes"]})
        self.assertTrue(all("born" in n and "mtime" in n for n in g["nodes"]))

    def test_editing_does_not_make_a_note_new(self):
        born = {n["id"]: n["born"] for n in brain.graph()["nodes"]}["pricing"]
        n = brain.note("pricing")
        brain.save_note("pricing", n["text"] + "more\n", n["mtime"])        # replaces the file
        p = brain.ROOT / "departments/finance/pricing/pricing.md"
        later = born + 86400
        os.utime(p, (later, later))                                        # as if born again a day later
        self.assertEqual({n["id"]: n["born"] for n in brain.graph()["nodes"]}["pricing"], born)

    def test_add_link(self):
        res, err = brain.add_link("pricing", "pod-idea-queue")
        self.assertIsNone(err)
        self.assertIn("## Links\n- [[pod-idea-queue]]", res["text"])
        res, _ = brain.add_link("pricing", "finance")                      # goes into the same section
        self.assertEqual(res["text"].count("## Links"), 1)
        before = res["text"]
        res, _ = brain.add_link("pricing", "finance")                      # idempotent
        self.assertEqual(res["text"], before)
        self.assertIsNotNone(brain.add_link("pricing", "pricing")[1])
        self.assertIsNotNone(brain.add_link("pricing", "../etc")[1])
        g = brain.graph()
        pairs = {frozenset((e["source"], e["target"])) for e in g["links"]}
        self.assertIn(frozenset(("pricing", "pod-idea-queue")), pairs)

    def test_suggestions(self):
        s = brain.suggestions("pod-idea-queue")
        self.assertEqual([x["id"] for x in s["mentioned_in"]], ["pricing"])  # names it, doesn't link it
        self.assertIn("POD idea queue", s["mentioned_in"][0]["snippet"])
        s = brain.suggestions("pricing")
        self.assertEqual([x["id"] for x in s["mentions"]], ["pod-idea-queue"])
        brain.add_link("pricing", "pod-idea-queue")
        self.assertEqual(brain.suggestions("pricing")["mentions"], [])
        # a link to another note is not a mention: "[[finance-notebook]]" does not name "finance"
        _write(brain.ROOT, "plan.md", "# Plan\n\nSee [[finance-notebook]].\n")
        self.assertNotIn("plan", [x["id"] for x in brain.suggestions("finance")["mentioned_in"]])
        self.assertIsNone(brain.suggestions("nope"))


class VoiceIntentTests(BrainFixture):
    def ui(self, text):
        r = commands.fast_path(text)
        return r and r.get("ui")

    def test_brain_phrases(self):
        self.assertEqual(self.ui("Atlas, show me pricing in my brain."), {"view": "brain", "action": "open", "id": "pricing"})
        self.assertEqual(self.ui("open my pricing notes")["id"], "pricing")
        self.assertEqual(self.ui("brain, finance notebook")["id"], "finance-notebook")
        self.assertEqual(self.ui("open the brain")["action"], "open")
        self.assertEqual(self.ui("close the brain")["action"], "close")
        self.assertEqual(self.ui("what's new in my brain this week")["action"], "timeline")
        self.assertEqual(self.ui("isolate finance"), {"view": "brain", "action": "isolate", "id": "finance"})
        self.assertEqual(self.ui("find quarterly taxes in my brain")["action"], "search")

    def test_does_not_steal_normal_requests(self):
        for text in ("focus on marketing this week", "brain dump my day", "show me my meeting notes",
                     "open chrome", "what's new"):
            self.assertIsNone(self.ui(text), text)


class BrainRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = brain.ROOT
        cls.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = r = pathlib.Path(cls.tmp.name)
        _write(r, "Atlas.md", "# Atlas\n")
        _write(r, "plan.md", "# Plan\n\nAbout the Atlas hub.\n")
        cls.srv = server.JarvisServer(("127.0.0.1", 0), server.Handler)
        cls._port, server.PORT = server.PORT, cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{server.PORT}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        server.PORT = cls._port
        brain.ROOT = cls._root
        cls.tmp.cleanup()

    def req(self, path, body=None, token=True, origin=True):
        h = {}
        if origin:
            h["Origin"] = self.base
        if token:
            h["X-Jarvis-Token"] = server.API_TOKEN
        data = None
        if body is not None:
            h["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        r = urllib.request.Request(self.base + path, data=data, headers=h, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_write_routes(self):
        self.assertEqual(self.req("/api/brain/link", {"source": "plan", "target": "Atlas"}, token=False)[0], 401)
        self.assertEqual(self.req("/api/brain/link", {"source": "plan", "target": "Atlas"}, origin=False)[0], 403)
        code, res = self.req("/api/brain/link", {"source": "plan", "target": "Atlas"})
        self.assertEqual(code, 200)
        self.assertIn("[[Atlas]]", res["note"]["text"])
        code, res = self.req("/api/brain/note", {"create": "Next Steps", "near": "plan"})
        self.assertEqual((code, res["note"]["path"]), (200, "notes/next-steps.md"))
        n = res["note"]
        code, res = self.req("/api/brain/note", {"id": "next-steps", "text": "# Next\n", "base_mtime": n["mtime"]})
        self.assertEqual(code, 200)
        code, _ = self.req("/api/brain/note", {"id": "next-steps", "text": "# Older\n", "base_mtime": n["mtime"] - 100})
        self.assertEqual(code, 409)
        code, s = self.req("/api/brain/suggest?id=Atlas")
        self.assertEqual(code, 200)
        self.assertIn("mentioned_in", s)


if __name__ == "__main__":
    unittest.main()
