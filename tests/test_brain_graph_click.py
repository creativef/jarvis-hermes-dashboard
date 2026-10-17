"""Headless-browser click test for the Atlas Brain graph (ui/app.js).

The interaction maths is unit-tested in test_brain_graph_ui.py, but the complaint
was behavioural: "nodes do not respond when I am clearly on them". This test drives
the REAL page — the real ui/index.html, app.js and styles.css served by the real
server.py — in headless Chrome over the DevTools Protocol and clicks the canvas at
a node's *drawn* centre (and at an offset of several pixels) and asserts a selection
happens. It also checks that nothing is eating pointer events over the canvas and
that the cursor reports a grabbable node on hover.

Hermetic and safe: server.py is started against a throwaway ATLAS_BRAIN fixture on a
free port with the mock runtime and a temp state file, so the real ~/Atlas and
state.json are never read or written. Nothing is committed, sent or spent.

Skips (does not fail) when Chrome, the websockets package, or Node is unavailable.

    python3 -m unittest discover -s tests
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
CHROME = os.environ.get("CHROME_BIN") or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
NODE = shutil.which("node")

try:                                                    # optional, only needed for CDP
    import websockets.sync.client as _wsc
    WS_OK = True
except Exception:                                       # noqa: BLE001
    _wsc = None
    WS_OK = False
CHROME_OK = os.path.exists(CHROME)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


_FIXTURE = {
    "Atlas.md": "# Atlas\n\nThe hub.\n\n## Departments\n- [[design-content]]\n- [[marketing]]\n\n## Shared\n- [[inbox]]\n",
    "departments/design-content/design-content.md":
        "# Design and Content department\n\nPart of [[Atlas]].\n\n## Sub-teams\n"
        "- [[ui-ux]] - UI and UX - Interface design, interaction patterns, motion.\n",
    "departments/design-content/ui-ux/ui-ux.md":
        "# UI and UX\n\nPart of [[design-content]]. Works with [[development]].\n",
    "departments/marketing/marketing.md": "# Marketing department\n\nPart of [[Atlas]].\n",
    "inbox/inbox.md": "# Inbox\n\nPart of [[Atlas]].\n",
    "inbox/inbox-note-a.md": "# Note A\n\n- **Links:** [[Atlas]] [[inbox]]\n\n## Content\n\nA dropped note.\n",
}


def _write_fixture(root):
    for rel, text in _FIXTURE.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)


class _CDP:
    """Minimal DevTools Protocol client over one websocket."""

    def __init__(self, ws_url):
        self.ws = _wsc.connect(ws_url, max_size=None)
        self._id = 0

    def cmd(self, method, **params):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg

    def ev(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=await_promise)
        res = r.get("result", {})
        if res.get("exceptionDetails"):
            raise RuntimeError("JS error: " + str(res["exceptionDetails"].get("text")))
        return res.get("result", {}).get("value")

    def ev_json(self, expr, await_promise=False):
        return json.loads(self.ev(expr, await_promise=await_promise))

    def mouse(self, kind, x, y, buttons=0, button="none", click_count=0):
        self.cmd("Input.dispatchMouseEvent", type=kind, x=float(x), y=float(y),
                 button=button, buttons=buttons, clickCount=click_count)

    def click(self, x, y, drift=0.0):
        """A real press/release, optionally dragging a pixel or two first."""
        self.mouse("mouseMoved", x, y, buttons=0)
        self.mouse("mousePressed", x, y, buttons=1, button="left", click_count=1)
        if drift:
            self.mouse("mouseMoved", x + drift, y + drift, buttons=1, button="left")
        self.mouse("mouseReleased", x + drift, y + drift, buttons=0, button="left", click_count=1)

    def close(self):
        try:
            self.ws.close()
        except Exception:                                # noqa: BLE001
            pass


def _wait_http(url, timeout=25.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                return json.loads(r.read())
        except Exception:                                # noqa: BLE001
            time.sleep(0.25)
    raise RuntimeError(f"service at {url} did not come up")


@unittest.skipUnless(CHROME_OK and WS_OK and NODE,
                     "headless Chrome, websockets and node are required for the click test")
class BrainGraphClickTests(unittest.TestCase):
    """Click the drawn graph in a real browser and assert selection happens."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="atlas-click-")
        brain = os.path.join(cls.tmp, "brain")
        os.makedirs(brain, exist_ok=True)
        _write_fixture(brain)

        cls.port = _free_port()
        cls.dport = _free_port()
        env = dict(os.environ)
        env.update(JARVIS_PORT=str(cls.port), JARVIS_OPEN="0", JARVIS_RUNTIME="mock",
                   JARVIS_LOCAL_VOICE="0", ATLAS_BRAIN=brain,
                   JARVIS_STATE=os.path.join(cls.tmp, "state.json"))
        cls.server = subprocess.Popen([sys.executable, "server.py"], cwd=ROOT, env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _wait_http(f"http://127.0.0.1:{cls.port}/api/health")

        cls.chrome_dir = os.path.join(cls.tmp, "chrome")
        cls.chrome = subprocess.Popen(
            [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
             f"--remote-debugging-port={cls.dport}", f"--user-data-dir={cls.chrome_dir}",
             "--window-size=1440,900", f"http://127.0.0.1:{cls.port}/"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _wait_http(f"http://127.0.0.1:{cls.dport}/json/version")

        # attach to the page target
        page = None
        end = time.time() + 20
        while time.time() < end and not page:
            targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cls.dport}/json/list", timeout=2).read())
            page = next((t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
            if not page:
                time.sleep(0.25)
        if not page:
            raise RuntimeError("no Chrome page target")
        time.sleep(1.0)                                  # let app.js boot
        cls.cdp = _CDP(page["webSocketDebuggerUrl"])
        cls.cdp.cmd("Runtime.enable")
        cls.cdp.ev("window.AtlasBrain.open()", await_promise=True)
        # wait for the graph to load
        end = time.time() + 15
        while time.time() < end and not cls.cdp.ev("!!(window.AtlasBrain && window.AtlasBrain.ready && window.AtlasBrain.ready())"):
            time.sleep(0.2)
        time.sleep(0.4)                                  # let the panel's open animation finish
        cls.rect = cls.cdp.ev_json(
            "JSON.stringify((()=>{const r=document.getElementById('brainCanvas').getBoundingClientRect();"
            "return {left:r.left,top:r.top,width:r.width,height:r.height};})())")

    @classmethod
    def tearDownClass(cls):
        for p in (getattr(cls, "cdp", None),):
            if p:
                p.close()
        for proc in (getattr(cls, "chrome", None), getattr(cls, "server", None)):
            if proc:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except Exception:                        # noqa: BLE001
                    proc.kill()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ── helpers ──────────────────────────────────────────────
    def _rect(self):
        """The canvas box in *client* coords, re-read live — the panel animates on open, so a
        rect cached at open time is a stale, slightly-scaled box that offsets every click."""
        return self.cdp.ev_json(
            "JSON.stringify((()=>{const r=document.getElementById('brainCanvas').getBoundingClientRect();"
            "return {left:r.left,top:r.top,width:r.width,height:r.height};})())")

    def _client_pt(self, canvas_pt):
        rect = self._rect()
        return rect["left"] + canvas_pt["x"], rect["top"] + canvas_pt["y"]

    def _screen_of(self, node_id):
        return self.cdp.ev_json(f"JSON.stringify(window.AtlasBrain.screenOf({json.dumps(node_id)}))")

    def _wait_settled(self, timeout=12.0):
        """Wait until the force simulation has stopped moving nodes."""
        end = time.time() + timeout
        while time.time() < end:
            if self.cdp.ev("window.AtlasBrain.settled()"):
                return True
            time.sleep(0.15)
        return False

    def _settle_pointer(self, node_id):
        """Move the pointer onto the node (parallax + forces settle) and return its client point."""
        self._wait_settled()
        p = self._screen_of(node_id)
        cx, cy = self._client_pt(p)
        self.cdp.mouse("mouseMoved", cx, cy, buttons=0)
        time.sleep(0.35)
        return self._client_pt(self._screen_of(node_id))

    def setUp(self):
        # a previous selection re-heats the simulation; let nodes come to rest first
        self._wait_settled()

    def _select(self, node_id):
        return self.cdp.ev("window.AtlasBrain.selectedId()")

    # ── tests ────────────────────────────────────────────────
    def test_graph_loaded(self):
        self.assertTrue(self.cdp.ev("window.AtlasBrain.ready()"))
        ids = self.cdp.ev_json("JSON.stringify(window.AtlasBrain.nodeIds())")
        self.assertIn("Atlas", ids)
        self.assertGreaterEqual(len(ids), 5)

    def test_canvas_receives_pointer_events(self):
        # A CSS layer or transform must not be sitting over the canvas.
        cx, cy = self._client_pt(self._screen_of("Atlas"))
        self.assertEqual(self.cdp.ev(f"document.elementFromPoint({cx},{cy}).id"), "brainCanvas")

    def test_click_on_drawn_centre_selects(self):
        cx, cy = self._settle_pointer("Atlas")
        self.cdp.click(cx, cy)
        time.sleep(0.5)
        self.assertEqual(self._select("Atlas"), "Atlas")
        self.assertEqual(self.cdp.ev("document.getElementById('brTitle').textContent"), "Atlas")

    def test_click_offset_by_several_pixels_still_selects(self):
        # The complaint was "I am clearly on the node but nothing happens": a click a
        # few px off the drawn centre (inside the generous hit radius) must still pick it.
        cx, cy = self._settle_pointer("design-content")
        self.cdp.click(cx + 6, cy - 6)
        time.sleep(0.5)
        self.assertEqual(self._select("design-content"), "design-content")

    def test_click_on_label_selects_the_node(self):
        node = "marketing"
        self.assertTrue(self.cdp.ev(f"window.AtlasBrain.labelShown({json.dumps(node)})"))
        self._wait_settled()
        lab = self.cdp.ev_json(f"JSON.stringify(window.AtlasBrain.labelOf({json.dumps(node)}))")
        node_pt = self._screen_of(node)
        # aim at the far horizontal edge of the caption band: outside the node blob, inside the label
        target_canvas = {"x": lab["x"] + lab["w"] / 2 - 4, "y": lab["y"]}
        dist_from_node = ((target_canvas["x"] - node_pt["x"]) ** 2 + (target_canvas["y"] - node_pt["y"]) ** 2) ** 0.5
        self.assertGreater(dist_from_node, 24, "label test point should be off the node blob")
        cx, cy = self._client_pt(target_canvas)
        self.cdp.mouse("mouseMoved", cx, cy, buttons=0)
        time.sleep(0.35)
        # re-aim from the freshly settled positions before clicking
        lab = self.cdp.ev_json(f"JSON.stringify(window.AtlasBrain.labelOf({json.dumps(node)}))")
        cx, cy = self._client_pt({"x": lab["x"] + lab["w"] / 2 - 4, "y": lab["y"]})
        self.cdp.click(cx, cy)
        time.sleep(0.5)
        self.assertEqual(self._select(node), node)

    def test_plain_click_survives_a_tiny_pointer_movement(self):
        # A one-pixel drift is a click, not a drag.
        cx, cy = self._settle_pointer("inbox-note-a")
        self.cdp.click(cx, cy, drift=1)
        time.sleep(0.5)
        self.assertEqual(self._select("inbox-note-a"), "inbox-note-a")

    def test_hover_shows_the_grabbable_cursor(self):
        cx, cy = self._settle_pointer("Atlas")
        self.assertEqual(self.cdp.ev("window.AtlasBrain.hoverId()"), "Atlas")
        self.assertIn("node-hover", self.cdp.ev("document.getElementById('brainCanvas').className"))


if __name__ == "__main__":
    unittest.main()