"""Tests for the local markdown renderer (ui/markdown.js).

The renderer is browser JavaScript, so the tests drive the real shipped file
through Node and assert on the HTML it returns. If Node is not installed the
suite skips rather than fails (the renderer itself is still exercised in the
browser).

    python3 -m unittest discover -s tests
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MARKDOWN_JS = os.path.normpath(os.path.join(HERE, "..", "ui", "markdown.js"))
NODE = shutil.which("node")

# A tiny Node harness: load the renderer into a fake window, render a JSON list
# of markdown inputs, and print the JSON list of HTML results.
HARNESS = """
global.window = global;
const fs = require('fs');
eval(fs.readFileSync(process.argv[2], 'utf8'));
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = cases.map(c => window.AtlasMarkdown.render(c.input, c.opts || {}));
process.stdout.write(JSON.stringify(out));
"""


def _render_batch(cases):
    """cases: list of (markdown, opts|None) -> list of html strings."""
    assert NODE, "node executable not found"
    payload = [{"input": md, "opts": opts or {}} for md, opts in cases]
    with tempfile.TemporaryDirectory() as d:
        hp = os.path.join(d, "harness.js")
        ip = os.path.join(d, "in.json")
        with open(hp, "w", encoding="utf-8") as f:
            f.write(HARNESS)
        with open(ip, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        proc = subprocess.run(
            [NODE, hp, MARKDOWN_JS, ip],
            capture_output=True, text=True, timeout=60,
        )
    if proc.returncode != 0:
        raise AssertionError("renderer failed:\n" + (proc.stderr or proc.stdout))
    return json.loads(proc.stdout)


@unittest.skipUnless(NODE, "node is required to exercise the browser renderer")
class MarkdownRendererTests(unittest.TestCase):
    def render(self, md, opts=None):
        return _render_batch([(md, opts)])[0]

    # ── existence / API ───────────────────────────────────────────────────
    def test_renderer_file_exists(self):
        self.assertTrue(os.path.isfile(MARKDOWN_JS), MARKDOWN_JS)

    def test_returns_string(self):
        self.assertIsInstance(self.render("# hi"), str)

    def test_no_network_primitives(self):
        """The renderer must be fully local: no fetch/XHR/worker/CDN."""
        with open(MARKDOWN_JS, encoding="utf-8") as f:
            src = f.read()
        for bad in ("fetch(", "XMLHttpRequest", "importScripts", "new Worker",
                    "navigator.sendBeacon"):
            self.assertNotIn(bad, src, f"renderer must not use {bad}")
        self.assertNotIn("cdn.", src)

    # ── headings ──────────────────────────────────────────────────────────
    def test_headings(self):
        html = self.render("# One\n## Two\n### Three\n#### Four")
        for lv, txt in ((1, "One"), (2, "Two"), (3, "Three"), (4, "Four")):
            self.assertIn(f"<h{lv} class=\"md-h md-h{lv}\">{txt}</h{lv}>", html)

    # ── emphasis / inline code ────────────────────────────────────────────
    def test_bold_and_italic(self):
        html = self.render("a **bold** and *italic* and __also bold__ and _also italic_")
        self.assertIn("<strong>bold</strong>", html)
        self.assertIn("<em>italic</em>", html)
        self.assertIn("<strong>also bold</strong>", html)
        self.assertIn("<em>also italic</em>", html)

    def test_inline_code_is_literal(self):
        html = self.render("use `**not bold**` here")
        self.assertIn("<code>**not bold**</code>", html)
        self.assertNotIn("<strong>", html)

    def test_snake_case_is_not_italicised(self):
        html = self.render("the file_name_here stays put")
        self.assertNotIn("<em>", html)

    # ── fenced code ───────────────────────────────────────────────────────
    def test_fenced_code_block(self):
        html = self.render("```python\nx = 1 < 2\nprint(x)\n```")
        self.assertIn('<pre class="md-pre"><code', html)
        self.assertIn('data-lang="python"', html)
        self.assertIn("x = 1 &lt; 2", html)      # escaped
        self.assertIn("print(x)", html)
        self.assertNotIn("<strong>", html)

    def test_tilde_fence(self):
        html = self.render("~~~\nplain\n~~~")
        self.assertIn("plain", html)
        self.assertIn("md-pre", html)

    # ── links ─────────────────────────────────────────────────────────────
    def test_links(self):
        html = self.render("[OpenAI](https://openai.com)")
        self.assertIn('href="https://openai.com"', html)
        self.assertIn('rel="noopener noreferrer"', html)
        self.assertIn(">OpenAI</a>", html)

    def test_unsafe_link_scheme_is_dropped(self):
        html = self.render("[click](javascript:alert(1))")
        self.assertNotIn("<a ", html)
        self.assertNotIn('href="javascript:', html)
        # it stays as plain, inert text
        self.assertIn("[click](javascript:alert(1))", html)

    # ── lists ─────────────────────────────────────────────────────────────
    def test_bullet_list(self):
        html = self.render("- one\n- two\n- three")
        self.assertEqual(html.count("<li>"), 3)
        self.assertIn("<ul class=\"md-list\">", html)

    def test_numbered_list(self):
        html = self.render("1. first\n2. second")
        self.assertIn("<ol class=\"md-list\">", html)
        self.assertEqual(html.count("<li>"), 2)

    def test_nested_list(self):
        html = self.render("- top\n  - child\n  - child2\n- top2")
        self.assertIn("<ul class=\"md-list\"><li>top<ul class=\"md-list\">", html)
        self.assertIn("<li>child</li>", html)
        self.assertEqual(html.count("</ul>"), 2)

    # ── blockquote / rule ─────────────────────────────────────────────────
    def test_blockquote(self):
        html = self.render("> quoted text\n> more")
        self.assertIn('<blockquote class="md-quote">', html)
        self.assertIn("quoted text", html)
        self.assertIn("more", html)

    def test_horizontal_rule(self):
        for rule in ("---", "***", "___", "- - -"):
            self.assertIn('<hr class="md-hr">', self.render(rule))

    # ── tables ────────────────────────────────────────────────────────────
    def test_pipe_table(self):
        html = self.render("| Name | Qty |\n|:-----|----:|\n| Pens | 3 |")
        self.assertIn('<table class="md-table">', html)
        self.assertIn("<th", html)
        self.assertIn("Name", html)
        self.assertIn("Pens", html)
        self.assertIn('style="text-align:left"', html)
        self.assertIn('style="text-align:right"', html)

    def test_center_aligned_column(self):
        html = self.render("| a |\n|:-:|\n| 1 |")
        self.assertIn('style="text-align:center"', html)

    # ── wikilinks ─────────────────────────────────────────────────────────
    def test_wikilink_plain(self):
        html = self.render("See [[research-strategy]] for more.")
        self.assertIn('class="md-wikilink"', html)
        self.assertIn('data-node="research-strategy"', html)
        self.assertIn(">research-strategy</a>", html)

    def test_wikilink_with_label(self):
        html = self.render("[[pod-design|POD Design]]")
        self.assertIn('data-node="pod-design"', html)
        self.assertIn(">POD Design</a>", html)

    def test_wikilink_with_section(self):
        html = self.render("[[atlas#intro]]")
        self.assertIn('data-node="atlas"', html)

    def test_wikilink_ids_are_preserved_verbatim(self):
        ids = ["Atlas", "inbox", "research-strategy", "business-operations"]
        html = self.render(" ".join(f"[[{i}]]" for i in ids))
        for i in ids:
            self.assertIn(f'data-node="{i}"', html)

    # ── inbox metadata callouts ───────────────────────────────────────────
    def test_proposed_triage_callout(self):
        html = self.render(
            "- **Proposed triage:** file → [[strategy]] (in [[research-strategy]])\n"
            "- **Kind:** csv"
        )
        self.assertIn("md-callout", html)
        self.assertIn("md-callout-triage", html)
        self.assertIn(">Proposed triage</span>", html)
        # the other metadata line is a plain meta row, not a callout
        self.assertIn('class="md-meta"', html)
        self.assertIn(">Kind</span>", html)

    def test_metadata_paragraph(self):
        html = self.render("**Saved:** 2026-10-17")
        self.assertIn('class="md-meta"', html)
        self.assertIn(">Saved</span>", html)

    # ── safety / escaping ─────────────────────────────────────────────────
    def test_html_is_escaped(self):
        html = self.render("<script>alert('x')</script> & <b>raw</b>")
        self.assertNotIn("<script>", html)
        self.assertNotIn("<b>raw</b>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("&amp;", html)

    def test_attribute_injection_in_wikilink(self):
        html = self.render('[[x"><img src=x>]]')
        self.assertNotIn("<img", html)
        self.assertNotIn('data-node="x"', html)   # the quote is escaped, id kept whole

    # ── paragraphs ────────────────────────────────────────────────────────
    def test_paragraph_keeps_line_breaks(self):
        html = self.render("line one\nline two")
        self.assertIn('<p class="md-p">line one<br>line two</p>', html)

    def test_blank_lines_split_paragraphs(self):
        html = self.render("first\n\nsecond")
        self.assertEqual(html.count("<p class=\"md-p\">"), 2)

    # ── integration: a realistic inbox note ───────────────────────────────
    def test_full_inbox_note(self):
        note = (
            "# q4-pod-batch.csv\n\n"
            "- **Inbox ID:** `q4-pod-batch`\n"
            "- **Kind:** csv\n"
            "- **Proposed triage:** queue for review → [[pod-design]] (in [[design-content]])\n"
            "- **Links:** [[Atlas]] [[inbox]]\n\n"
            "## Content\n\n"
            "| sku | title |\n|---|---|\n| A1 | Mugs |\n"
        )
        html = self.render(note)
        self.assertIn("<h1", html)
        self.assertIn("md-callout-triage", html)
        self.assertIn('<table class="md-table">', html)
        self.assertIn('data-node="pod-design"', html)
        self.assertIn('data-node="design-content"', html)
        self.assertIn('data-node="Atlas"', html)


if __name__ == "__main__":
    unittest.main()
