"""Brain search, quick capture, rename, archive and health, with their spoken phrases and
HTTP routes. Every test runs against a throwaway ATLAS_BRAIN folder.

    python3 -m unittest tests.test_brain_tidy
"""
import datetime
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.request

import brain
import commands
import phrases
import server


def _write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


class Fixture(unittest.TestCase):
    def setUp(self):
        self._root = brain.ROOT
        self.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = r = pathlib.Path(self.tmp.name)
        self.r = r
        _write(r, "Atlas.md", "# Atlas\n\n[[finance]] [[supplier-list]]\n")
        _write(r, "departments/finance/finance.md", "# Finance\n\nPart of [[Atlas]]. Teams: [[pricing]].\n")
        _write(r, "departments/finance/pricing/pricing.md",
               "# Pricing\n\nHoodie base price went up. See [[supplier-list|our suppliers]] and [[Supplier-List]].\n")
        _write(r, "notes/supplier-list.md", "# Supplier list\n\nPrintful raised the hoodie base price in March. [[Atlas]]\n")
        _write(r, "notes/stray-idea.md", "# Stray idea\n\nA mug about Mondays.\n")
        _write(r, "departments/finance/ideas.md", "# Ideas\n\n[[Atlas]] and [[no-such-note]]\n")
        _write(r, "notes/ideas.md", "# Ideas again: same name, so the graph cannot show it\n")

    def tearDown(self):
        brain.ROOT = self._root
        self.tmp.cleanup()

    def ui(self, text):
        r = commands.fast_path(text)
        return r and r.get("ui")


class SearchTests(Fixture):
    def test_finds_words_inside_notes_with_a_snippet(self):
        res = brain.search("hoodie base price")
        self.assertEqual([x["id"] for x in res["results"]], ["pricing", "supplier-list"])
        self.assertIn("base price", res["results"][0]["snippet"])
        self.assertEqual(brain.search("printful")["results"][0]["id"], "supplier-list")

    def test_a_name_match_outranks_a_mention(self):
        self.assertEqual(brain.search("supplier")["results"][0]["id"], "supplier-list")

    def test_every_word_must_appear_and_empty_is_empty(self):
        self.assertEqual(brain.search("hoodie zeppelin")["count"], 0)
        self.assertEqual(brain.search("   ")["results"], [])

    def test_spoken_search(self):
        r = commands.fast_path("search my brain for printful")
        self.assertEqual(r["ui"], {"view": "brain", "action": "find", "q": "printful", "id": "supplier-list"})
        self.assertIn("supplier list", r["reply"])
        self.assertEqual(self.ui("what do my notes say about hoodie")["action"], "find")
        self.assertIn("Nothing", commands.fast_path("search my brain for zeppelins")["reply"])
        self.assertEqual(self.ui("show me pricing in my brain")["action"], "open")      # a name still wins


class CaptureTests(Fixture):
    def test_note_that_lands_in_this_months_quick_notes(self):
        r = commands.fast_path("Atlas, make a note that Printful raised prices again.")
        self.assertIn(r["reply"], phrases.lines("noted"))
        name = f"quick-notes-{datetime.date.today():%Y-%m}"
        self.assertEqual(r["ui"], {"view": "brain", "action": "wrote", "id": name})
        text = (self.r / "notes" / f"{name}.md").read_text()
        self.assertIn("[[Atlas]]", text)                                   # joins the graph
        self.assertIn(f"## {datetime.date.today().isoformat()}", text)
        self.assertRegex(text, r"- \d\d:\d\d Printful raised prices again\.")
        commands.fast_path("note to self call the supplier on Monday")
        text = (self.r / "notes" / f"{name}.md").read_text()
        self.assertEqual(text.count("## "), 1)                             # one heading per day
        self.assertIn("Call the supplier on Monday", text)

    def test_add_to_a_named_note(self):
        r = commands.fast_path("add ask about bulk discount to my supplier list notes")
        self.assertEqual(r["ui"]["id"], "supplier-list")
        self.assertIn("- Ask about bulk discount (", (self.r / "notes/supplier-list.md").read_text())
        r = commands.fast_path("add to my pricing notes: review hoodie margin")
        self.assertEqual(r["ui"]["id"], "pricing")
        self.assertIn("- Review hoodie margin (", (self.r / "departments/finance/pricing/pricing.md").read_text())

    def test_does_not_steal_normal_requests(self):
        for text in ("add milk to my shopping notes",          # no such note: Hermes decides
                     "note", "take notes", "what did I note yesterday", "add a hoodie to the store",
                     "notice that the price changed", "can you write a note to the supplier"):
            self.assertIsNone(commands.fast_path(text), text)


class RenameArchiveTests(Fixture):
    def test_rename_moves_the_file_and_repoints_links(self):
        note, err = brain.rename_note("supplier-list", "Print Partners")
        self.assertIsNone(err)
        self.assertEqual((note["id"], note["renamed_from"], note["relinked"]), ("print-partners", "supplier-list", 2))
        self.assertTrue((self.r / "notes/print-partners.md").exists())
        self.assertFalse((self.r / "notes/supplier-list.md").exists())
        self.assertIn("[[print-partners]]", (self.r / "Atlas.md").read_text())
        pricing = (self.r / "departments/finance/pricing/pricing.md").read_text()
        self.assertIn("[[print-partners|our suppliers]]", pricing)         # the label is kept
        self.assertIn("[[Supplier-List]]", pricing)                        # a different spelling is not the same link
        self.assertIn({"source": "Atlas", "target": "print-partners"}, brain.graph()["links"])

    def test_rename_refuses_structure_clashes_and_bad_titles(self):
        for name in ("Atlas", "finance", "pricing"):
            self.assertIn("structure", brain.rename_note(name, "Something Else")[1])
        self.assertIn("already exists", brain.rename_note("stray-idea", "Supplier List")[1])
        self.assertIn("title", brain.rename_note("stray-idea", "../../etc/passwd")[1])
        self.assertEqual(brain.rename_note("nope", "x")[1], "note not found")

    def test_archive_moves_the_note_out_and_says_who_still_links(self):
        res, err = brain.archive_note("supplier-list")
        self.assertIsNone(err)
        self.assertEqual(res["linked_from"], ["Atlas", "pricing"])
        self.assertTrue((self.r / ".archive/supplier-list.md").exists())    # kept, not deleted
        self.assertIsNone(brain.note("supplier-list"))
        self.assertIn("structure", brain.archive_note("finance")[1])


class HealthTests(Fixture):
    def test_reports_broken_links_orphans_and_hidden_duplicates(self):
        h = brain.health()
        self.assertIn({"from": "ideas", "to": "no-such-note", "did_you_mean": ""}, h["broken"])
        self.assertIn({"from": "pricing", "to": "Supplier-List", "did_you_mean": "supplier-list"}, h["broken"])
        self.assertEqual(h["orphans"], ["stray-idea"])
        self.assertEqual(h["duplicates"], [{"id": "ideas", "shown": "departments/finance/ideas.md",
                                            "hidden": ["notes/ideas.md"]}])

    def test_spoken_health(self):
        r = commands.fast_path("check my brain")
        self.assertEqual(r["ui"]["action"], "health")
        self.assertIn("broken link", r["reply"])


class RouteTests(Fixture):
    def setUp(self):
        super().setUp()
        self.srv = server.JarvisServer(("127.0.0.1", 0), server.Handler)
        self._port = server.PORT
        server.PORT = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        server.PORT = self._port
        super().tearDown()

    def _call(self, path, body=None):
        base = f"http://127.0.0.1:{server.PORT}"
        headers = {"X-Jarvis-Token": server.API_TOKEN, "Origin": base, "Content-Type": "application/json"}
        req = urllib.request.Request(base + path, json.dumps(body).encode() if body is not None else None, headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_search_health_rename_archive(self):
        code, res = self._call("/api/brain/search?q=printful")
        self.assertEqual((code, res["results"][0]["id"]), (200, "supplier-list"))
        code, res = self._call("/api/brain/health")
        self.assertEqual((code, res["orphans"]), (200, ["stray-idea"]))
        code, res = self._call("/api/brain/note", {"rename": "stray-idea", "title": "Monday mug"})
        self.assertEqual((code, res["note"]["id"]), (200, "monday-mug"))
        code, res = self._call("/api/brain/note", {"rename": "Atlas", "title": "Nope"})
        self.assertEqual(code, 400)
        code, res = self._call("/api/brain/note", {"archive": "monday-mug"})
        self.assertEqual((code, res["note"]["archived"]), (200, ".archive/monday-mug.md"))


if __name__ == "__main__":
    unittest.main()
