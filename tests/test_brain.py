import pathlib
import tempfile
import unittest

import brain


class DepartmentsTests(unittest.TestCase):
    def setUp(self):
        self._root = brain.ROOT
        self.tmp = tempfile.TemporaryDirectory()
        brain.ROOT = pathlib.Path(self.tmp.name)

    def tearDown(self):
        brain.ROOT = self._root
        self.tmp.cleanup()

    def _dept(self, slug, text, teams=()):
        d = brain.ROOT / "departments" / slug
        d.mkdir(parents=True)
        (d / f"{slug}.md").write_text(text, encoding="utf-8")
        for t in teams:
            (d / t).mkdir()

    def test_missing_folder(self):
        r = brain.departments()
        self.assertFalse(r["exists"])
        self.assertEqual(r["departments"], [])

    def test_parses_name_remit_and_teams(self):
        self._dept("finance", "# Finance and Tax department\n\n## Remit\nKnow the numbers.\n\n"
                              "## Sub-teams\n- [[pricing]] - Pricing and Margins - Unit economics.\n"
                              "- [[ghost]] - Not a folder - ignored.\n\n## How to work\n- x\n",
                   teams=["pricing"])
        r = brain.departments()
        self.assertTrue(r["exists"])
        (d,) = r["departments"]
        self.assertEqual((d["slug"], d["name"], d["remit"]), ("finance", "Finance & Tax", "Know the numbers."))
        self.assertEqual(d["teams"], [{"slug": "pricing", "name": "Pricing & Margins", "remit": "Unit economics."}])

    def test_known_order_first(self):
        for s in ("zeta", "marketing", "finance"):
            self._dept(s, f"# {s.title()} department\n")
        self.assertEqual([d["slug"] for d in brain.departments()["departments"]], ["marketing", "finance", "zeta"])


if __name__ == "__main__":
    unittest.main()
