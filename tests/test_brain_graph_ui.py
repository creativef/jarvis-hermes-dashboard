"""Tests for the Atlas Brain graph interaction fixes in ui/app.js.

The graph lives inside a browser IIFE, so it is checked two ways:

1. Behavioural: the pure interaction math (picking with a hit margin, the
   click/drag movement threshold, and wheel/pinch zoom) is exported on ``window.AtlasGraphMath`` and
   delimited by ``/* @graph-math:start|end */`` markers. The block is DOM-free, so
   the shipped code is driven here through Node exactly as the browser uses it.

2. The real page is clicked in headless Chrome by test_brain_graph_click.py.

If Node is not installed the behavioural tests skip rather than fail.

    python3 -m unittest discover -s tests
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.normpath(os.path.join(HERE, "..", "ui"))
APP_JS = os.path.join(UI, "app.js")
STYLES_CSS = os.path.join(UI, "styles.css")
THEMES_CSS = os.path.join(UI, "themes.css")
INDEX_HTML = os.path.join(UI, "index.html")
NODE = shutil.which("node")

# A tiny Node harness: load the graph-math block into a fake window, run a JSON
# list of cases, and print the JSON list of results. Nodes are identified by their
# index so the Python side can assert on identity.
HARNESS = """
global.window = global;
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const START = '/* @graph-math:start */', END = '/* @graph-math:end */';
const a = src.indexOf(START), b = src.indexOf(END);
if (a < 0 || b < 0) throw new Error('graph-math markers not found in app.js');
eval(src.slice(a, b + END.length));
const G = window.AtlasGraphMath;
if (!G) throw new Error('window.AtlasGraphMath was not exported');
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = cases.map(c => {
  if (c.op === 'const') return [G.HIT_PAD, G.DRAG_THRESHOLD];
  if (c.op === 'pickRadius') return G.pickRadius(c.r, c.k);
  if (c.op === 'moved') return G.moved(c.a, c.b, c.th == null ? undefined : c.th);
  if (c.op === 'zoomAt') return c.deltas.reduce((v, d) => G.zoomAt(v, d, c.px, c.py, c.W, c.H), c.view);
  if (c.op === 'pick') {
    const nodes = c.nodes.map((n, i) => Object.assign({i}, n));
    const visible = n => n.visible !== false;
    const radiusOf = t => (c.radius && c.radius[t] != null) ? c.radius[t] : 4.5;
    const r = G.pick(nodes, c.world, c.k, visible, radiusOf);
    return r ? r.i : null;
  }
  throw new Error('unknown op: ' + c.op);
});
process.stdout.write(JSON.stringify(out));
"""


def _run(cases):
    assert NODE, "node executable not found"
    with tempfile.TemporaryDirectory() as d:
        hp = os.path.join(d, "harness.js")
        ip = os.path.join(d, "in.json")
        with open(hp, "w", encoding="utf-8") as f:
            f.write(HARNESS)
        with open(ip, "w", encoding="utf-8") as f:
            json.dump(cases, f)
        proc = subprocess.run([NODE, hp, APP_JS, ip], capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError("graph-math harness failed:\n" + (proc.stderr or proc.stdout))
    return json.loads(proc.stdout)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node is required to exercise the shipped browser logic")
class GraphMathTests(unittest.TestCase):
    def test_math_block_is_exported(self):
        (pads, thresh), = _run([{"op": "const"}])
        # a hit margin comfortably wider than the old 5px, and a real drag threshold
        self.assertGreaterEqual(pads, 8)
        self.assertGreaterEqual(thresh, 2)
        self.assertLessEqual(thresh, 10)

    def test_pick_radius_scales_with_zoom(self):
        (at1, at2, at4) = _run([
            {"op": "pickRadius", "r": 6, "k": 1},
            {"op": "pickRadius", "r": 6, "k": 2},
            {"op": "pickRadius", "r": 6, "k": 4},
        ])
        pad = at1 - 6
        self.assertGreater(pad, 0)
        # the extra margin is a constant number of *screen* pixels at every zoom
        self.assertAlmostEqual(at2 - 6, pad / 2, places=6)
        self.assertAlmostEqual(at4 - 6, pad / 4, places=6)

    def test_pick_has_tolerance_around_the_centre(self):
        # node at the origin, drawn radius 6.5; a click 12px away must still hit it
        node = {"x": 0, "y": 0, "type": "dept"}
        hit = _run([{"op": "pick", "nodes": [node], "world": {"x": 12, "y": 0}, "k": 1,
                     "radius": {"dept": 6.5}}])[0]
        miss = _run([{"op": "pick", "nodes": [node], "world": {"x": 40, "y": 0}, "k": 1,
                      "radius": {"dept": 6.5}}])[0]
        self.assertEqual(hit, 0)
        self.assertIsNone(miss)

    def test_pick_prefers_the_nearest_centre(self):
        nodes = [{"x": -6, "y": 0, "type": "sub"}, {"x": 6, "y": 0, "type": "sub"}]
        got = _run([{"op": "pick", "nodes": nodes, "world": {"x": 2, "y": 0}, "k": 1}])[0]
        self.assertEqual(got, 1)

    def test_pick_prefers_the_front_node_on_overlap(self):
        # two nodes drawn at (almost) the same spot; the later-drawn one is on top
        nodes = [{"x": 0, "y": 0, "type": "sub"}, {"x": 0, "y": 0, "type": "sub"}]
        got = _run([{"op": "pick", "nodes": nodes, "world": {"x": 0, "y": 0}, "k": 1}])[0]
        self.assertEqual(got, 1)

    def test_pick_skips_hidden_nodes(self):
        nodes = [{"x": 0, "y": 0, "type": "notebook", "visible": False},
                 {"x": 20, "y": 0, "type": "sub"}]
        got = _run([{"op": "pick", "nodes": nodes, "world": {"x": 20, "y": 0}, "k": 1}])[0]
        self.assertEqual(got, 1)
        none = _run([{"op": "pick", "nodes": nodes, "world": {"x": 0, "y": 0}, "k": 1}])[0]
        self.assertIsNone(none)

    def test_movement_threshold(self):
        a = {"x": 100, "y": 100}
        res = _run([
            {"op": "moved", "a": a, "b": {"x": 100, "y": 100}},   # dead still
            {"op": "moved", "a": a, "b": {"x": 101, "y": 100}},   # 1px jitter
            {"op": "moved", "a": a, "b": {"x": 103, "y": 100}},   # 3px jitter
            {"op": "moved", "a": a, "b": {"x": 105, "y": 100}},   # 5px
            {"op": "moved", "a": a, "b": {"x": 100, "y": 120}},   # 20px
            {"op": "moved", "a": a, "b": {"x": 102, "y": 100}, "th": 1},  # explicit threshold
        ])
        self.assertFalse(res[0])
        self.assertFalse(res[1])   # a shaky click is still a click
        self.assertFalse(res[2])
        self.assertTrue(res[3])
        self.assertTrue(res[4])
        self.assertTrue(res[5])


    def test_trackpad_pinch_zooms_gently(self):
        # one short pinch: 20 tiny deltas. The old code jumped 10% per event and hit max zoom.
        view = {"x": 0, "y": 0, "k": 0.76}
        (v,) = _run([{"op": "zoomAt", "view": view, "deltas": [-3] * 20, "px": 400, "py": 250, "W": 900, "H": 560}])
        self.assertGreater(v["k"], 0.76)
        self.assertLess(v["k"], 2.0)

    def test_zoom_is_clamped_and_reversible(self):
        base = {"x": 0, "y": 0, "k": 1}
        (big, back) = _run([
            {"op": "zoomAt", "view": base, "deltas": [-100] * 40, "px": 0, "py": 0, "W": 900, "H": 560},
            {"op": "zoomAt", "view": base, "deltas": [-5, -5, 5, 5], "px": 300, "py": 200, "W": 900, "H": 560},
        ])
        self.assertAlmostEqual(big["k"], 3)
        self.assertAlmostEqual(back["k"], 1, places=6)

    def test_zoom_keeps_the_point_under_the_cursor(self):
        view, px, py, W, H = {"x": 30, "y": -20, "k": 0.8}, 610, 140, 900, 560
        (v,) = _run([{"op": "zoomAt", "view": view, "deltas": [-12], "px": px, "py": py, "W": W, "H": H}])
        world = lambda vw: ((px - W / 2 - vw["x"]) / vw["k"], (py - H / 2 - vw["y"]) / vw["k"])
        for a, b in zip(world(view), world(v)):
            self.assertAlmostEqual(a, b, places=6)


if __name__ == "__main__":
    unittest.main()
