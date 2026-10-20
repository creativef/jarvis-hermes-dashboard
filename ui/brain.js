/* Atlas · Second Brain view: graph math, the force-directed graph of the ~/Atlas notes,
   and the reading toolbar for its note panel. Moved out of app.js unchanged; it uses
   app.js globals ($, esc, apiHeaders, say, transmit …), so it loads right after app.js. */

/* ── pure interaction math for the Atlas Brain graph ─────────────────────────
   DOM-free helpers for picking (with a generous hit radius), the click/drag
   movement threshold, and the drawn hit radius. Exported on
   window.AtlasGraphMath and delimited by the @graph-math markers so the test in
   tests/test_brain_graph_ui.py can drive the real shipped logic through Node. */
/* @graph-math:start */
(() => {
  'use strict';
  const G = {
    HIT_PAD: 12,                    // extra *screen* px of clickable margin around every node (generous, zoom-consistent)
    DRAG_THRESHOLD: 4,              // CSS px the pointer may drift before it counts as a drag
    pickRadius: (r, k) => r + G.HIT_PAD / (k || 1),
    moved: (a, b, th) => Math.hypot(b.x - a.x, b.y - a.y) > (th == null ? G.DRAG_THRESHOLD : th),
    ZOOM_MIN: .35, ZOOM_MAX: 3,
    // Zoom in proportion to the scroll size (a trackpad pinch sends many tiny deltas, a mouse
    // notch one big one), keeping the world point under (px, py) fixed on screen.
    zoomAt: (view, deltaY, px, py, W, H) => {
      const d = Math.max(-50, Math.min(50, deltaY));
      const k = Math.max(G.ZOOM_MIN, Math.min(G.ZOOM_MAX, view.k * Math.exp(-d * 0.01)));
      const wx = (px - W / 2 - view.x) / view.k, wy = (py - H / 2 - view.y) / view.k;
      return {x: px - W / 2 - wx * k, y: py - H / 2 - wy * k, k};
    },
    // nodes: [{x,y,type,…}]; world: {x,y} of the pointer; visible(n); radiusOf(type).
    // Nearest centre wins; on a tie the last-drawn (visually front) node wins, so a
    // click on overlapping nodes lands on the one you can actually see.
    pick: (nodes, world, k, visible, radiusOf) => {
      let best = null, bd = Infinity;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (visible && !visible(n)) continue;
        const r = G.pickRadius(radiusOf ? radiusOf(n.type) : 4.5, k);
        const d = Math.hypot(n.x - world.x, n.y - world.y);
        if (d < r && d < bd) { best = n; bd = d; }
      }
      return best;
    },
  };
  if (typeof window !== 'undefined') window.AtlasGraphMath = G;
})();
/* @graph-math:end */

// ══════════ second brain: force-directed graph of the Atlas notes ══════════
(() => {
  const ov = document.getElementById('brainOverlay'); if (!ov) return;
  const cv = document.getElementById('brainCanvas'), ctx = cv.getContext('2d');
  const $b = id => document.getElementById(id);
  const GM = window.AtlasGraphMath;
  const GROUP = {};                                   // dept slug -> [r,g,b], resolved from theme variables
  const RADIUS = {hub:16, dept:11, sub:6.5, inbox:6.5, notebook:3.5, commons:6, log:4, other:4};
  const INBOX_GROUP = '__inbox';                      // synthetic group key so the inbox cluster reads as a cluster
  // Depth layering: 0 = nearest the viewer (biggest, brightest, most shadow), higher = pushed back.
  // hub → dept → inbox/commons cluster → sub → notebook/log strays. Drives size, shade and ambient shadow.
  const LAYER = {hub:0, dept:1, inbox:2, commons:2, sub:3, log:4, notebook:4, other:4};
  const LAYER_N = 5;
  const layerOf = n => (LAYER[n.type] == null ? 3 : LAYER[n.type]);
  const colorOf = n => n.type === 'hub' ? HUB : n.type === 'inbox' ? INBOX : (GROUP[n.group] || NEUTRAL);
  let INK = '234,246,250', HUB = [240,250,255], INBOX = [79,230,245], NEUTRAL = [130,160,180], FONT = 'system-ui, sans-serif', LIGHT = false;
  let ACCENT = '79,230,245', BG = '5,11,18', SH = '0,0,0', AMBER = [255,190,92], GREEN = [62,232,168];
  const probe = document.createElement('i'); probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  ov.appendChild(probe);
  const rgbOf = (css, dflt) => {                      // any CSS colour/var -> [r,g,b]
    probe.style.color = ''; probe.style.color = css;
    const m = getComputedStyle(probe).color.match(/[\d.]+/g);
    if (!m || m.length < 3) return dflt;
    const v = /srgb/.test(getComputedStyle(probe).color) ? m.slice(0, 3).map(x => Math.round(x * 255)) : m.slice(0, 3).map(Math.round);
    return v.every(Number.isFinite) ? v : dflt;
  };
  const deptList = () => (window.AtlasData ? AtlasData.depts : []);
  const readTheme = () => {
    const cs = getComputedStyle(document.documentElement);
    INK = cs.getPropertyValue('--ink-rgb').trim() || INK;
    ACCENT = cs.getPropertyValue('--accent-rgb').trim() || ACCENT;   // gradient tint
    BG = cs.getPropertyValue('--bg-rgb').trim() || BG;               // gradient base = theme background
    SH = cs.getPropertyValue('--shadow-rgb').trim() || SH;           // vignette + ambient node shadow
    const h = cs.getPropertyValue('--hub-rgb').trim().split(',').map(Number);
    if (h.length === 3 && h.every(Number.isFinite)) HUB = h;
    NEUTRAL = rgbOf('var(--dim)', NEUTRAL);
    INBOX = rgbOf('var(--inbox-rgb)', INBOX);
    AMBER = rgbOf('var(--amber)', AMBER); GREEN = rgbOf('var(--green)', GREEN);
    LIGHT = document.documentElement.dataset.mode === 'light';
    FONT = getComputedStyle(document.body).fontFamily || FONT;
    for (const d of deptList()) GROUP[d.slug] = rgbOf(`var(${AtlasData.colorVar(d.slug)})`, NEUTRAL);
    if (!ov.hidden && W) draw();                      // repaint straight away on a theme/mode switch
  };
  const legend = () => {
    const hasInbox = nodes.some(n => n.type === 'inbox');
    $b('brLegend').innerHTML = deptList().map(d =>
      `<button type="button" class="lg-dept${collapsed.has(d.slug) ? ' off' : ''}" data-fold="${d.slug}" aria-pressed="${collapsed.has(d.slug)}" title="Fold or unfold this department"><i style="background:var(${AtlasData.colorVar(d.slug)})"></i>${d.name.replace(/&/g, '&amp;')}</button>`).join('')
      + (hasInbox ? '<span class="lg-inbox"><i></i>Inbox</span>' : '')
      + (nodes.some(n => n.type === 'other') ? '<span><i style="background:var(--dim)"></i>Other notes</span>' : '')
      + '<span><i style="background:rgb(var(--hub-rgb))"></i>Atlas hub</span><span class="lg-hint" title="Drag a node to pin it, double-click to unpin. Click a department to fold it. Scroll to pan, pinch or ⌘+scroll to zoom.">⇧-drag to link · arrows hop · <kbd>X</kbd> isolate · <kbd>L</kbd> timeline · <kbd>E</kbd> edit · <kbd>N</kbd> new · <kbd>F</kbd> fit</span>';
  };
  let nodes = [], links = [], byId = new Map(), adj = new Map();
  const PIN_KEY = 'atlas.brain.pins';
  let pins = {};
  try { pins = JSON.parse(localStorage.getItem(PIN_KEY) || '{}') || {}; } catch (_) {}
  const savePins = () => { try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch (_) {} };
  // What is on stage beyond the type toggles: folded departments · isolate (a note + neighbours) · timeline cursor.
  const FOLD_KEY = 'atlas.brain.folded', collapsed = new Set();
  try { for (const s of JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) collapsed.add(s); } catch (_) {}
  let iso = null, isoSet = null;                       // {id, depth} and the ids it keeps on stage
  const tl = {on: false, t: 0, t0: 0, t1: 0, playing: false, last: 0};   // timeline cursor (epoch seconds)
  const WEEK = 7 * 86400;
  const fresh = n => tl.on && n.born > tl.t - WEEK && n.born <= tl.t;  // born in the week before the cursor
  const touched = new Map();                           // id → {at, kind}: notes Atlas read or wrote recently
  let linkDrag = null;                                 // ⇧-drag from one node to another adds a [[link]]
  const mini = $b('brMini'), mctx = mini ? mini.getContext('2d') : null;
  let miniT = null;                                    // world → minimap transform, kept for clicks
  let W = 0, H = 0, dpr = 1, raf = 0, alpha = 1;
  let view = {x:0, y:0, k:1}, hover = null, selected = null, drag = null, pan = null, moved = false;
  let searchQuery = '', searchMatches = [], searchIdx = 0, flyAnim = null, viewSaved = null;
  let downX = 0, downY = 0, downId = null, lastPX = null, lastPY = null, pointerIn = false;
  const edgePulses = [], nodeSparks = new Map();
  // Depth & life: breathing, a staggered fade-in, and an idle animation loop.
  let lastDraw = 0, revealT0 = 0, revealTotal = 0;     // fade-in stagger bookkeeping
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
  let REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (window.matchMedia){
    const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onRm = () => { REDUCE = rmq.matches; if (!ov.hidden && !raf) loop(); else draw(); };
    if (rmq.addEventListener) rmq.addEventListener('change', onRm);
    else if (rmq.addListener) rmq.addListener(onRm);
  }
  readTheme(); legend();
  addEventListener('atlas-theme', readTheme);
  if (window.AtlasData) AtlasData.onChange(() => { readTheme(); legend(); if (!ov.hidden) load(); });

  const fit = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
    if (!ov.hidden && W) draw();                      // setting .width/.height clears the bitmap: repaint at once
  };
  new ResizeObserver(fit).observe(cv);
  // Re-fit when the display's pixel ratio changes (e.g. the window moves to a monitor
  // with a different scale factor), so the bitmap is never left at the old resolution.
  let dprMq = null;
  const watchDpr = () => {
    if (!window.matchMedia) return;
    if (dprMq && dprMq.removeEventListener) dprMq.removeEventListener('change', watchDpr);
    dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (dprMq.addEventListener) dprMq.addEventListener('change', watchDpr);
    fit();
  };
  watchDpr();

  const showNb = () => $b('brNotebooks').checked, showSh = () => $b('brShared').checked;
  const typeOn = n => n.type === 'notebook' ? showNb() : (n.type === 'commons' || n.type === 'log') ? showSh() : true;
  const visible = n => typeOn(n)
    && !(n.type !== 'dept' && n.group && collapsed.has(n.group))
    && (!isoSet || isoSet.has(n.id))
    && (!tl.on || !n.born || n.born <= tl.t);

  function pulseNode(nodeId, kind = 'read'){
    const n = byId.get(nodeId);
    if (!n) return;
    const now = performance.now();
    nodeSparks.set(n.id, now);
    for (const l of links){
      if (l.a.id === n.id || l.b.id === n.id){
        const from = l.a.id === n.id ? l.a : l.b;
        const to = l.a.id === n.id ? l.b : l.a;
        edgePulses.push({from, to, born: now, dur: 950, kind});
      }
    }
    if (!ov.hidden && !raf) loop();
  }

  function flyTo(n, zoom = 1.25){
    if (!n) return;
    if (!visible(n)){                                 // bring it on stage whatever is hiding it
      if (n.type === 'notebook') $b('brNotebooks').checked = true;
      else if (n.type === 'commons' || n.type === 'log') $b('brShared').checked = true;
      if (n.group && n.type !== 'dept' && collapsed.has(n.group)) toggleFold(n.group);
      if (isoSet && !isoSet.has(n.id)) setIsolate(null, 1, false);
      if (tl.on && n.born > tl.t){ tl.t = tl.t1; tlSync(); }
    }
    const tk = Math.max(view.k, zoom);
    flyAnim = {
      t0: performance.now(), dur: 380,
      x0: view.x, y0: view.y, k0: view.k,
      x1: -n.x * tk, y1: -n.y * tk, k1: tk,
    };
    pulseNode(n.id, 'focus');
    if (!ov.hidden && !raf) loop();
  }

  function renderOutline(){
    const box = $b('brOutline'); if (!box || box.hidden) return;
    const groups = new Map();
    const matchSet = new Set(searchMatches.map(m => m.id));
    for (const n of nodes){
      if (!visible(n)) continue;
      const g = n.group || n.type || 'other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    }
    let html = '';
    for (const [g, list] of groups){
      html += `<div class="bo-group"><h4>${esc(g.replace(/-/g, ' '))} (${list.length})</h4><div class="bo-items">`
        + list.map(n => `<button type="button" class="bo-btn${matchSet.has(n.id) ? ' match' : ''}" data-node="${esc(n.id)}">${esc(n.id)}</button>`).join('')
        + `</div></div>`;
    }
    box.innerHTML = html || '<div class="pal-empty">No visible nodes.</div>';
  }

  async function load(){
    try {
      const g = await fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json());
      if (!g.nodes) throw 0;
      const old = new Map(nodes.map(n => [n.id, n]));
      const now = performance.now();
      nodes = g.nodes.map((n, i) => {
        const o = old.get(n.id), a = (i / g.nodes.length) * Math.PI * 2, p = pins[n.id];
        if (!o && old.size > 0) nodeSparks.set(n.id, now);
        return Object.assign(n, {x: p ? p[0] : o ? o.x : Math.cos(a) * 220 + Math.random() * 20,
                                 y: p ? p[1] : o ? o.y : Math.sin(a) * 220 + Math.random() * 20, vx: 0, vy: 0, pinned: !!p});
      });
      byId = new Map(nodes.map(n => [n.id, n]));
      // Re-point live references at the freshly built objects (ids survive a reload),
      // instead of leaving them holding the previous node objects.
      const reRef = o => (o ? byId.get(o.id) || null : null);
      selected = reRef(selected); hover = reRef(hover); drag = reRef(drag);
      if (searchMatches.length) searchMatches = searchMatches.map(reRef).filter(Boolean);
      links = g.links.map(l => ({a: byId.get(l.source), b: byId.get(l.target)})).filter(l => l.a && l.b);
      adj = new Map(nodes.map(n => [n.id, new Set()]));
      links.forEach(l => { adj.get(l.a.id).add(l.b.id); adj.get(l.b.id).add(l.a.id); });
      // Anchor any note that links to nothing (e.g. a big inbox source file) to the hub —
      // inbox notes to the inbox hub — so a stray note cannot drift off to the edge and
      // sit there as an unfindable speck.
      const hub = byId.get('Atlas') || nodes.find(n => n.type === 'hub');
      const inboxHub = nodes.find(n => n.type === 'inbox' && n.id === 'inbox');
      for (const n of nodes){
        if (adj.get(n.id).size) continue;
        const a = (n.type === 'inbox' && inboxHub && inboxHub !== n) ? inboxHub : hub;
        if (!a || a === n) continue;
        links.push({a: n, b: a, anchor: true});
        adj.get(n.id).add(a.id); adj.get(a.id).add(n.id);
      }
      alpha = 1;
      for (let i = 0; i < 320; i++) step();     // open already settled, not mid-scramble
      alpha = .05;
      revealT0 = performance.now(); revealTotal = nodes.length;   // fade-in stagger for the fresh layout
      if (!g.exists) $b('brTitle').textContent = 'No brain folder found at ' + g.root;
      legend(); renderOutline();
    } catch (_) { $b('brTitle').textContent = 'Could not load the brain'; }
  }

  const structural = l => { const t = [l.a.type, l.b.type]; return t.includes('hub') || t.includes('notebook') || (t.includes('dept') && t.includes('sub')); };
  const restLen = l => {
    const t = [l.a.type, l.b.type];
    return t.includes('hub') ? 160 : (t.includes('dept') && t.includes('sub')) ? 100 : t.includes('notebook') ? 34 : 190;
  };

  function step(){
    const vis = nodes.filter(visible), n = vis.length;
    for (let i = 0; i < n; i++){
      const a = vis[i];
      for (let j = i + 1; j < n; j++){
        const b = vis[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 160000) continue;
        const f = (4200 / d2) * alpha, d = Math.sqrt(d2);
        dx = dx / d * f; dy = dy / d * f;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
    }
    for (const l of links){
      if (!visible(l.a) || !visible(l.b)) continue;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - restLen(l)) * (structural(l) ? 0.035 : 0.008) * alpha, fx = dx / d * f, fy = dy / d * f;
      l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
    }
    for (const a of vis){
      a.vx -= a.x * 0.004 * alpha; a.vy -= a.y * 0.004 * alpha;
      if (a === drag || a.pinned){ a.vx = a.vy = 0; continue; }
      a.vx *= 0.82; a.vy *= 0.82; a.x += a.vx; a.y += a.vy;
    }
    alpha = Math.max(0.02, alpha * 0.985);
    let mx = 0, my = 0;                                   // keep the whole graph centred on the canvas
    for (const a of vis){ mx += a.x; my += a.y; }
    if (n){ mx /= n; my /= n; for (const a of vis){ if (a === drag || a.pinned) continue; a.x -= mx * 0.2; a.y -= my * 0.2; } }
  }

  function fitTo(list, animate){                          // frame these nodes with a margin
    if (!list.length || !W) return;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const a of list){ x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); y0 = Math.min(y0, a.y); y1 = Math.max(y1, a.y); }
    const k = Math.max(.45, Math.min(1.5, Math.min((W - 140) / Math.max(1, x1 - x0), (H - 110) / Math.max(1, y1 - y0))));
    const x = -((x0 + x1) / 2) * k, y = -((y0 + y1) / 2) * k;
    if (animate && !REDUCE){ flyAnim = {t0: performance.now(), dur: 420, x0: view.x, y0: view.y, k0: view.k, x1: x, y1: y, k1: k}; if (!raf && !ov.hidden) loop(); }
    else { view.x = x; view.y = y; view.k = k; draw(); }
  }
  const fitView = () => fitTo(nodes.filter(visible), false);

  const radiusOf = t => RADIUS[t] || 4.5;
  // ONE transform pair for the whole canvas. draw() translates by (W/2 + view.x, …) then
  // scales by view.k, and the hit test inverts exactly that — including devicePixelRatio, which the
  // ctx.setTransform(dpr,…) applies to the bitmap only, so both sides work in CSS pixels.
  const offX = () => W / 2 + view.x, offY = () => H / 2 + view.y;
  const toScreen = (wx, wy) => ({x: offX() + wx * view.k, y: offY() + wy * view.k});
  const toWorld = (px, py) => ({x: (px - offX()) / view.k, y: (py - offY()) / view.k});

  // Which labels are painted at the moment — shared by draw() and the label hit test so a
  // node's caption is exactly as clickable as the node itself.
  const labelVisible = n => {
    if (!visible(n)) return false;
    const focus = selected || hover, near = focus ? adj.get(focus.id) : null;
    const hoverNear = hover && hover !== focus ? adj.get(hover.id) : null;
    const isMatch = searchMatches.some(m => m.id === n.id);
    return n.type === 'hub' || n.type === 'dept' || n.type === 'inbox' || n === focus || n === hover || isMatch
        || (near && near.has(n.id) && n.type !== 'notebook')
        || (hoverNear && hoverNear.has(n.id) && n.type !== 'notebook')
        || (isoSet && n.type !== 'notebook') || fresh(n)
        || (n.type === 'sub' && view.k > .6);
  };
  const labelFontPx = () => 11 / Math.max(.7, Math.min(1.4, view.k));
  const labelText = n => {                               // long names are cut so they cannot cover neighbours
    const t = n.id.replace(/-/g, ' ');
    return (t.length <= 22 || n === hover || n === selected) ? t : t.slice(0, 21).trimEnd() + '…';
  };
  function labelBand(n){                                 // screen-space box around a node's caption
    const txt = labelText(n);
    ctx.save(); ctx.font = `${labelFontPx()}px ${FONT}`;
    const w = ctx.measureText(txt).width * view.k;       // world font × zoom → on-screen width
    ctx.restore();
    const s = toScreen(n.x, n.y);
    const gap = ((RADIUS[n.type] || 4.5) + 13 / Math.max(.7, view.k)) * view.k;
    return {x: s.x, y: s.y + gap, w: Math.max(18, w) + 14, h: Math.max(15, labelFontPx() * view.k * 1.6)};
  }
  // Nearest node wins; on overlap the front-most (last drawn) node wins; if no blob is hit, the
  // node whose *label* sits under the pointer is picked. This is the whole clickable surface.
  const pick = (px, py) => {
    const n = GM.pick(nodes, toWorld(px, py), view.k, visible, radiusOf);
    if (n) return n;
    for (let i = nodes.length - 1; i >= 0; i--){
      const c = nodes[i];
      if (!labelVisible(c)) continue;
      const b = labelBand(c);
      if (Math.abs(px - b.x) <= b.w / 2 && Math.abs(py - b.y) <= b.h / 2) return c;
    }
    return null;
  };

  function draw(){
    const now = performance.now();
    if (flyAnim){
      const u = Math.min(1, (now - flyAnim.t0) / flyAnim.dur);
      const e = 1 - Math.pow(1 - u, 3);
      view.x = flyAnim.x0 + (flyAnim.x1 - flyAnim.x0) * e;
      view.y = flyAnim.y0 + (flyAnim.y1 - flyAnim.y0) * e;
      view.k = flyAnim.k0 + (flyAnim.k1 - flyAnim.k0) * e;
      if (u >= 1) flyAnim = null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

    drawBackdrop();                                    // soft gradient + vignette, drawn from theme tokens

    ctx.save(); ctx.translate(offX(), offY()); ctx.scale(view.k, view.k);

    // Fade-in stagger when the graph opens: a quick whole-scene fade plus a per-node stagger.
    const sceneFade = (!revealT0 || REDUCE) ? 1 : Math.min(1, (now - revealT0) / 320);
    const revealAt = i => {
      if (!revealT0 || REDUCE) return 1;
      const u = (now - revealT0 - (revealTotal ? (i / revealTotal) * 380 : 0)) / 340;
      return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    };
    const focus = selected || hover, near = focus ? adj.get(focus.id) : null;
    const hoverNear = hover && hover !== focus ? adj.get(hover.id) : null;
    // Hover is never shadowed by the selection: dimming still follows the selection
    // (or hover when nothing is selected), but every hovered node keeps its own
    // lit node + neighbours so a different node always responds to the cursor.
    const lit = new Set();
    if (focus){ lit.add(focus.id); for (const id of adj.get(focus.id) || []) lit.add(id); }
    if (hover && hover !== focus){ lit.add(hover.id); for (const id of adj.get(hover.id) || []) lit.add(id); }
    const matchSet = searchMatches.length ? new Set(searchMatches.map(m => m.id)) : null;

    // Department colour halos behind clusters
    const deptCenters = new Map();
    for (const n of nodes){
      if (!visible(n)) continue;
      const key = n.group || (n.type === 'inbox' ? INBOX_GROUP : '');
      if (!key) continue;
      const c = key === INBOX_GROUP ? INBOX : (GROUP[key] || NEUTRAL);
      const g = deptCenters.get(key) || {x: 0, y: 0, count: 0, c};
      g.x += n.x; g.y += n.y; g.count++;
      deptCenters.set(key, g);
    }
    for (const [, g] of deptCenters){
      if (g.count < 2) continue;
      const gx = g.x / g.count, gy = g.y / g.count;
      const rad = 85;
      const gr = ctx.createRadialGradient(gx, gy, 8, gx, gy, rad);
      gr.addColorStop(0, `rgba(${g.c.join(',')},${(LIGHT ? 0.08 : 0.12) * sceneFade})`);
      gr.addColorStop(1, `rgba(${g.c.join(',')},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(gx, gy, rad, 0, Math.PI * 2); ctx.fill();
    }

    // Curved links: a gentle quadratic bow (stable per pair) with a slow flow running along them.
    const flowOff = REDUCE ? 0 : -((now * 0.02) / view.k) % 20;
    for (const l of links){
      if (!visible(l.a) || !visible(l.b)) continue;
      const hot = (focus && (l.a === focus || l.b === focus)) || (hover && (l.a === hover || l.b === hover)),
            c = colorOf(l.a.type === 'hub' ? l.b : l.a);
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
      const bow = Math.min(54, d * 0.12) * (hash(l.a.id + '~' + l.b.id) % 2 ? 1 : -1);
      const cxp = (l.a.x + l.b.x) / 2 - (dy / d) * bow, cyp = (l.a.y + l.b.y) / 2 + (dx / d) * bow;
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.quadraticCurveTo(cxp, cyp, l.b.x, l.b.y);
      ctx.strokeStyle = `rgba(${c.join(',')},${(hot ? .88 : focus ? .07 : .24) * sceneFade})`;
      ctx.lineWidth = (hot ? 2 : 1) / view.k; ctx.stroke();
      if (!REDUCE){                                    // subtle flow travelling along the same curve
        ctx.save(); ctx.setLineDash([5 / view.k, 15 / view.k]); ctx.lineDashOffset = flowOff;
        ctx.strokeStyle = `rgba(${c.join(',')},${(hot ? .5 : .10) * sceneFade})`;
        ctx.lineWidth = 1.4 / view.k; ctx.stroke(); ctx.restore();
      }
    }

    // Live edge pulses travelling along links when notes are read/written/focused
    for (let i = edgePulses.length - 1; i >= 0; i--){
      const p = edgePulses[i];
      const u = (now - p.born) / p.dur;
      if (u >= 1){ edgePulses.splice(i, 1); continue; }
      if (!visible(p.from) || !visible(p.to)) continue;
      const px = p.from.x + (p.to.x - p.from.x) * u;
      const py = p.from.y + (p.to.y - p.from.y) * u;
      const c = colorOf(p.to.type === 'hub' ? p.from : p.to);
      ctx.beginPath(); ctx.arc(px, py, 3.2 / view.k, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.join(',')},${1 - u * 0.6})`;
      ctx.shadowColor = `rgba(${c.join(',')},1)`; ctx.shadowBlur = 12;
      ctx.fill(); ctx.shadowBlur = 0;
    }

    // Nodes, layered by depth: nearer layers are larger, brighter and cast a soft ambient shadow.
    for (let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if (!visible(n)) continue;
      const rv = revealAt(i) * sceneFade;
      if (rv <= 0) continue;
      const c = colorOf(n), lay = layerOf(n), dep = lay / LAYER_N;
      const isHot = n === hover;
      const breath = REDUCE ? 1 : 1 + 0.03 * Math.sin(now / 900 + (hash(n.id) % 7) * 1.1);
      let r = (RADIUS[n.type] || 4.5) * (1.16 - dep * 0.30) * breath;   // size by layer
      if (isHot) r *= 1.22;                                            // hover lift
      const ny = n.y - (isHot && !REDUCE ? 3 / view.k : 0);
      const isMatch = matchSet && matchSet.has(n.id);
      const dim = (focus || matchSet) && !isMatch && !lit.has(n.id) && !fresh(n);
      if (lay <= 2 && !dim){                                           // soft ambient shadow
        const sg = ctx.createRadialGradient(n.x, ny + r * .7, 0, n.x, ny + r * .7, r * 3.1);
        sg.addColorStop(0, `rgba(${SH},${(LIGHT ? .10 : .34) * rv})`);
        sg.addColorStop(1, `rgba(${SH},0)`);
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(n.x, ny + r * .7, r * 3.1, 0, Math.PI * 2); ctx.fill();
      }
      if (n.type === 'hub' && !dim){                                   // the hub's own distinct aura
        ctx.beginPath(); ctx.arc(n.x, ny, r * 3.2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${c.join(',')},${.20 * rv})`; ctx.lineWidth = 1.4 / view.k; ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x, ny, r * 2.1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c.join(',')},${.10 * rv})`; ctx.fill();
      } else if (!dim && (n.type === 'dept' || n === selected || isHot || isMatch)){
        ctx.beginPath(); ctx.arc(n.x, ny, r * (isMatch ? 2.4 : 1.85), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c.join(',')},${(isMatch ? 0.28 : 0.14) * rv})`;
        ctx.fill();
      }
      // Spark ring when a node is newly born or pulsed
      const sp = nodeSparks.get(n.id);
      if (sp && now - sp < 1100){
        const su = (now - sp) / 1100;
        ctx.beginPath(); ctx.arc(n.x, ny, r + su * 22, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${c.join(',')},${(1 - su) * 0.9})`;
        ctx.lineWidth = 2 / view.k; ctx.stroke();
      } else if (sp){
        nodeSparks.delete(n.id);
      }
      ctx.beginPath(); ctx.arc(n.x, ny, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.join(',')},${(dim ? .16 : (.98 - dep * .22)) * rv})`;   // brighter foreground
      ctx.shadowColor = `rgba(${c.join(',')},.85)`;
      ctx.shadowBlur = dim ? 0 : (isMatch ? 20 : isHot ? 22 : lay <= 1 ? 16 : lay >= 4 ? 4 : 10);
      ctx.fill(); ctx.shadowBlur = 0;
      if (n === selected || isMatch){
        ctx.lineWidth = (isMatch ? 2.4 : 2) / view.k;
        ctx.strokeStyle = isMatch ? '#4fe6f5' : `rgb(${INK})`;
        ctx.stroke();
      } else if (isHot){
        ctx.lineWidth = 1.6 / view.k;                 // hover ring, distinct from the selection ring
        ctx.strokeStyle = `rgba(${c.join(',')},.9)`;
        ctx.stroke();
      }
    }
    // Overlays: notes Atlas touched (amber = read, green = wrote), fresh notes on the timeline,
    // folded departments, and the ⇧-drag link line.
    for (const n of nodes){
      if (!visible(n)) continue;
      const r = (RADIUS[n.type] || 4.5) + 6 / view.k, t = touched.get(n.id);
      if (t){
        const u = (now - t.at) / 60000;
        if (u >= 1) touched.delete(n.id);
        else {
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${(t.kind === 'write' ? GREEN : AMBER).join(',')},${.9 * (1 - u)})`;
          ctx.lineWidth = 2.2 / view.k; ctx.stroke();
        }
      }
      if (fresh(n)){
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2);
        ctx.setLineDash([3 / view.k, 3 / view.k]); ctx.strokeStyle = `rgba(${GREEN.join(',')},.95)`;
        ctx.lineWidth = 1.6 / view.k; ctx.stroke(); ctx.setLineDash([]);
      }
      if (n.type === 'dept' && collapsed.has(n.group)){
        const hidden = nodes.reduce((c, m) => c + (m.group === n.group && m.type !== 'dept' && typeOn(m) ? 1 : 0), 0);
        const bx = n.x + r, by = n.y - r, br = 9 / view.k;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${colorOf(n).join(',')},.95)`; ctx.fill();
        ctx.fillStyle = `rgb(${BG})`; ctx.font = `700 ${9 / view.k}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+' + hidden, bx, by + .5 / view.k); ctx.textBaseline = 'alphabetic';
      }
    }
    if (linkDrag){
      const w = toWorld(linkDrag.px, linkDrag.py), f = linkDrag.from;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(w.x, w.y);
      ctx.setLineDash([6 / view.k, 5 / view.k]); ctx.strokeStyle = `rgba(${GREEN.join(',')},.95)`;
      ctx.lineWidth = 2 / view.k; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = `${labelFontPx()}px ${FONT}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if (!labelVisible(n)) continue;
      const rv = revealAt(i) * sceneFade;
      if (rv <= 0) continue;
      const isMatch = matchSet && matchSet.has(n.id);
      const dim = (focus || matchSet) && !isMatch && !lit.has(n.id) && !fresh(n);
      const dep = layerOf(n) / LAYER_N;
      ctx.fillStyle = `rgba(${INK},${(dim ? .30 : (.96 - dep * .28)) * rv})`;
      ctx.fillText(labelText(n), n.x, n.y + (RADIUS[n.type] || 4.5) + 13 / Math.max(.7, view.k));
    }
    ctx.restore();
    drawMini();
  }

  // Minimap: every node on stage plus the rectangle you are looking at. Click or drag it to move.
  function drawMini(){
    if (!mctx || !W || mini.offsetParent === null) return;
    const vis = nodes.filter(visible); if (!vis.length) return;
    const mw = mini.clientWidth, mh = mini.clientHeight;
    if (mini.width !== Math.round(mw * dpr)){ mini.width = Math.round(mw * dpr); mini.height = Math.round(mh * dpr); }
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const a of vis){ x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); y0 = Math.min(y0, a.y); y1 = Math.max(y1, a.y); }
    x0 -= 40; y0 -= 40; x1 += 40; y1 += 40;
    const s = Math.min(mw / (x1 - x0), mh / (y1 - y0));
    const ox = (mw - (x1 - x0) * s) / 2 - x0 * s, oy = (mh - (y1 - y0) * s) / 2 - y0 * s;
    miniT = {s, ox, oy};
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0); mctx.clearRect(0, 0, mw, mh);
    for (const n of vis){
      mctx.fillStyle = `rgb(${colorOf(n).join(',')})`;
      mctx.beginPath(); mctx.arc(ox + n.x * s, oy + n.y * s, n.type === 'hub' ? 2.8 : n.type === 'dept' ? 2.2 : 1.3, 0, Math.PI * 2); mctx.fill();
    }
    const a = toWorld(0, 0), b = toWorld(W, H);
    mctx.strokeStyle = `rgba(${ACCENT},.95)`; mctx.lineWidth = 1;
    mctx.strokeRect(ox + a.x * s + .5, oy + a.y * s + .5, (b.x - a.x) * s, (b.y - a.y) * s);
  }
  if (mini){
    const jump = e => {
      if (!miniT) return;
      const r = mini.getBoundingClientRect();
      flyAnim = null; viewSaved = null;
      view.x = -((e.clientX - r.left - miniT.ox) / miniT.s) * view.k;
      view.y = -((e.clientY - r.top - miniT.oy) / miniT.s) * view.k;
      draw();
    };
    mini.addEventListener('pointerdown', e => { mini.setPointerCapture(e.pointerId); jump(e); });
    mini.addEventListener('pointermove', e => { if (mini.hasPointerCapture(e.pointerId)) jump(e); });
    mini.addEventListener('dblclick', () => fitTo(nodes.filter(visible), true));
  }

  function drawBackdrop(){
    const cx = W / 2, cy = H / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * .78);
    g.addColorStop(0, `rgba(${ACCENT},${LIGHT ? .10 : .16})`);
    g.addColorStop(.5, `rgba(${BG},0)`);
    g.addColorStop(1, `rgba(${BG},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .34, W / 2, H / 2, Math.max(W, H) * .72);
    v.addColorStop(0, `rgba(${SH},0)`);
    v.addColorStop(1, `rgba(${SH},${LIGHT ? .10 : .40})`);
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  function loop(){
    if (ov.hidden || document.hidden){ raf = 0; return; }
    const now = performance.now();
    if (W){
      const settled = alpha <= 0.021 && !drag;         // forces have stopped; skip the O(n²) pass
      if (!settled && !tl.on) step();                 // timeline replays growth in place, so no layout
      if (tl.playing) tickTimeline(now);
      // Recompute hover from the last pointer position every frame, so the highlight
      // never goes stale while the graph settles, flies, or after a refresh.
      if (pointerIn && !drag && !pan && lastPX != null){
        const h = pick(lastPX, lastPY);
        if (h !== hover){ hover = h; setCursor(); }
      }
      const busy = !settled || flyAnim || edgePulses.length > 0 || nodeSparks.size > 0 || drag || pan || tl.playing || linkDrag;
      // Idle motion (breathing / parallax / flow) redraws on a ~30fps budget; with reduced
      // motion the canvas is static and only redraws on demand.
      if (busy || (!REDUCE && now - lastDraw > 32)){ draw(); lastDraw = now; }
    }
    const activeAnim = alpha > 0.021 || flyAnim || edgePulses.length > 0 || nodeSparks.size > 0 || drag || pan || tl.playing || !REDUCE;
    raf = activeAnim ? requestAnimationFrame(loop) : 0;
  }
  const setCursor = () => cv.classList.toggle('node-hover', !!(hover && !drag));

  async function openNote(n){
    if (editing && editing.id !== n.id){
      if (isDirty()){ editMsg('Save or cancel this edit first.'); return; }
      stopEdit();
    }
    if (iso && iso.id !== n.id && !editing) setIsolate(n.id, iso.depth);   // isolate walks with you
    selected = n; alpha = Math.max(alpha, .15); syncToDept(n);
    $b('brSuggest').hidden = true;
    pulseNode(n.id, 'read');
    const note = $b('brText');
    note._raw = ''; note._noteId = n.id; note.scrollTop = 0;
    $b('brTitle').textContent = n.id; $b('brPath').textContent = '';
    note.innerHTML = '<p class="md-p md-loading">loading…</p>';
    const box = $b('brLinks'); box.textContent = '';
    for (const id of [...(adj.get(n.id) || [])].sort()){
      const b = document.createElement('button'); b.textContent = id.replace(/-/g, ' ');
      b.onclick = () => { const t = byId.get(id); if (t){ if (!visible(t)) { if (t.type === 'notebook') $b('brNotebooks').checked = true; else $b('brShared').checked = true; } flyTo(t, 1.15); openNote(t); } };
      box.appendChild(b);
    }
    try {
      const r = await fetch('/api/brain/note?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(r => r.json());
      if (selected !== n) return;
      $b('brPath').textContent = r.path || '';
      const text = r.text || r.error || '';
      note._raw = text;
      if (window.AtlasMarkdown) note.innerHTML = AtlasMarkdown.render(text);
      else note.textContent = text;
      note.scrollTop = 0;
      $b('brEdit').disabled = r.editable === false;
      $b('brEdit').title = r.editable === false ? 'This note is too large to edit here' : 'Edit this note (E)';
      loadSuggest(n);
    } catch (_) { note._raw = ''; note.innerHTML = '<p class="md-p">could not load note</p>'; }
  }

  // [[wikilinks]] render as links that jump straight to that node in the graph
  $b('brText').addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a.md-wikilink');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    const id = a.dataset.node;
    const t = byId.get(id) || [...byId.values()].find(x => x.id.toLowerCase() === String(id).toLowerCase());
    if (!t) return;
    if (!visible(t)){ if (t.type === 'notebook') $b('brNotebooks').checked = true; else $b('brShared').checked = true; }
    flyTo(t, 1.3); openNote(t);
  });

  const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const endPointer = () => { drag = null; pan = null; linkDrag = null; moved = false; downId = null; cv.classList.remove('drag'); };
  cv.addEventListener('pointerdown', e => {
    if (downId !== null) return;                       // ignore a second pointer while a gesture is live
    cv.setPointerCapture(e.pointerId);
    const [px, py] = pos(e); moved = false;
    downX = e.clientX; downY = e.clientY; downId = e.pointerId;
    const n = pick(px, py);
    if (n && e.shiftKey){ linkDrag = {from: n, px, py}; cv.classList.add('drag'); return; }
    if (n){ drag = n; cv.classList.add('drag'); }      // grabbing cursor while dragging a node too
    else { pan = {x: e.clientX, y: e.clientY, vx: view.x, vy: view.y}; cv.classList.add('drag'); viewSaved = null; }
  });
  cv.addEventListener('pointermove', e => {
    if (downId !== null && e.pointerId !== downId) return;
    const [px, py] = pos(e);
    lastPX = px; lastPY = py; pointerIn = true;
    if (linkDrag){
      linkDrag.px = px; linkDrag.py = py;
      const h = pick(px, py); hover = h !== linkDrag.from ? h : null; draw();
      return;
    }
    if (drag || pan){
      // A click is only a drag once the pointer has moved past the threshold, so a
      // jittery click still selects instead of silently becoming a drag.
      if (!moved && GM.moved({x: downX, y: downY}, {x: e.clientX, y: e.clientY})) moved = true;
      if (moved){
        if (drag){ const w = toWorld(px, py); drag.x = w.x; drag.y = w.y; alpha = Math.max(alpha, .3); if (!raf) loop(); }
        else { view.x = pan.vx + e.clientX - pan.x; view.y = pan.vy + e.clientY - pan.y; if (!raf) loop(); }
      }
    } else {
      const h = pick(px, py); if (h !== hover){ hover = h; setCursor(); draw(); }
    }
  });
  cv.addEventListener('pointerup', e => {
    if (downId !== null && e.pointerId !== downId) return;
    const [px, py] = pos(e);
    lastPX = px; lastPY = py;
    if (linkDrag){
      const from = linkDrag.from, to = pick(px, py);
      endPointer(); hover = to; setCursor(); draw();
      if (to && to !== from) linkNotes(from.id, to.id);
      return;
    }
    const wasMoved = moved, dropped = drag;
    endPointer();
    if (wasMoved && dropped){ dropped.pinned = true; pins[dropped.id] = [dropped.x, dropped.y]; savePins(); }
    if (!wasMoved){ const n = pick(px, py); if (n) openNote(n); else { selected = null; syncToDept(null); } }
    hover = pick(px, py);                              // clear a stale hover left by a drag/pan
    setCursor();
    if (!raf) loop(); else draw();
  });
  cv.addEventListener('dblclick', e => {               // release a pinned node back to the layout
    const n = pick(...pos(e));
    if (n && n.pinned){ n.pinned = false; delete pins[n.id]; savePins(); alpha = Math.max(alpha, .3); if (!raf) loop(); }
  });
  cv.addEventListener('pointercancel', () => { endPointer(); if (pointerIn) hover = pick(lastPX, lastPY); setCursor(); if (!raf) loop(); });
  cv.addEventListener('lostpointercapture', () => { if (downId !== null){ endPointer(); setCursor(); } });
  cv.addEventListener('pointerleave', () => { pointerIn = false; if (hover){ hover = null; setCursor(); draw(); } });
  cv.addEventListener('pointerenter', e => { const [px, py] = pos(e); pointerIn = true; lastPX = px; lastPY = py; });
  // Two-finger scroll pans; pinch (the browser reports it as ctrlKey) or ⌘/Ctrl+scroll zooms.
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    viewSaved = null; flyAnim = null;                  // a manual move is the new "restore" home
    const line = e.deltaMode === 1 ? 16 : 1;           // some mice report lines, not pixels
    if (e.ctrlKey || e.metaKey){ const [px, py] = pos(e); Object.assign(view, GM.zoomAt(view, e.deltaY * line, px, py, W, H)); }
    else { view.x -= e.deltaX * line; view.y -= e.deltaY * line; }
    draw();
  }, {passive: false});

  // Search box with fly-to + accessible outline toggle + live tool edge pulses
  const searchInput = $b('brSearch'), searchCount = $b('brSearchCount');
  const outlineBtn = $b('brOutlineToggle'), outlineBox = $b('brOutline');
  const saveView = () => { if (!viewSaved) viewSaved = {x: view.x, y: view.y, k: view.k}; };
  const restoreView = () => {                          // put the camera back where it was before the search
    if (!viewSaved) return;
    const v = viewSaved; viewSaved = null;
    flyAnim = {t0: performance.now(), dur: 320, x0: view.x, y0: view.y, k0: view.k, x1: v.x, y1: v.y, k1: v.k};
    if (!raf) loop();
  };
  function updateSearch(fly = false){
    searchQuery = (searchInput?.value || '').toLowerCase().trim();
    if (!searchQuery){
      searchMatches = []; searchIdx = 0;
      if (searchCount) searchCount.hidden = true;
      restoreView();
      renderOutline(); draw();
      return;
    }
    searchMatches = nodes.filter(n => n.id.toLowerCase().includes(searchQuery) || (n.group || '').toLowerCase().includes(searchQuery));
    if (searchCount){
      searchCount.hidden = false;
      searchCount.textContent = searchMatches.length ? `${(searchIdx % searchMatches.length) + 1}/${searchMatches.length}` : '0';
    }
    if (searchMatches.length && fly){                   // only Enter / a click on a result flies + opens
      const target = searchMatches[searchIdx % searchMatches.length];
      saveView();
      flyTo(target, 1.35);
      openNote(target);
    } else {
      draw();
    }
    renderOutline();
  }
  if (searchInput){
    searchInput.addEventListener('input', () => { searchIdx = 0; updateSearch(false); });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && searchMatches.length){
        e.preventDefault();
        searchIdx = (searchIdx + (e.shiftKey ? searchMatches.length - 1 : 1)) % searchMatches.length;
        updateSearch(true);
      } else if (e.key === 'Escape' && searchInput.value){
        e.stopPropagation();
        searchInput.value = ''; updateSearch(false);
      }
    });
  }
  if (outlineBtn && outlineBox){
    outlineBtn.addEventListener('click', () => {
      const on = outlineBox.hidden;
      outlineBox.hidden = !on;
      outlineBtn.setAttribute('aria-pressed', String(on));
      if (on) renderOutline();
    });
    outlineBox.addEventListener('click', e => {
      const b = e.target.closest('[data-node]'); if (!b) return;
      const n = byId.get(b.dataset.node);
      if (n){ outlineBox.hidden = true; outlineBtn.setAttribute('aria-pressed', 'false'); flyTo(n, 1.3); openNote(n); }
    });
  }

  // ══ small helpers ══
  const pretty = id => String(id).replace(/-/g, ' ');
  const escA = s => esc(s).replace(/"/g, '&quot;');
  const post = (url, body) => fetch(url, {method: 'POST', headers: apiHeaders({'content-type': 'application/json'}), body: JSON.stringify(body)})
    .then(async r => ({status: r.status, ...(await r.json().catch(() => ({})))}))
    .catch(() => ({ok: false, error: 'Could not reach the dashboard server.'}));
  const actEl = $b('brActivity'); let actTimer = 0;
  const chip = (text, ms = 2400) => {                  // small status line on the graph (top-left)
    if (!actEl) return;
    clearTimeout(actTimer); actEl.textContent = text || ''; actEl.hidden = !text;
    if (text && ms) actTimer = setTimeout(() => { actEl.hidden = true; }, ms);
  };
  const navPing = () => { const b = $b('navBrain'); if (!b) return; b.classList.remove('brain-ping'); void b.offsetWidth; b.classList.add('brain-ping'); };

  // ══ Atlas ↔ Brain: voice actions, and notes lighting up as Atlas reads or writes them ══
  const WRITE_TOOL = /write|patch|edit|create|append|save|replace|insert|move/i;
  let runWrote = false;
  const notesIn = inp => nodes.filter(n => n.id.length > 3 && (inp.includes('/' + n.id + '.md') || inp.includes('[[' + n.id)
                                                            || (n.id.length > 5 && inp.includes(n.id))));
  const origBrainHandle = handle;
  handle = ev => {
    try {
      if (ev.t === 'ui' && ev.ui && ev.ui.view === 'brain') voiceAction(ev.ui);
      else if (ev.t === 'tool' && ev.phase === 'use' && nodes.length){
        const inp = String(ev.input || ''), write = WRITE_TOOL.test(ev.name || '');
        if (write && /atlas/i.test(inp)) runWrote = true;
        const hit = notesIn(inp);
        for (const n of hit){ touched.set(n.id, {at: performance.now(), kind: write ? 'write' : 'read'}); pulseNode(n.id, 'tool'); }
        if (hit.length){ chip(`◉ Atlas is ${write ? 'writing' : 'reading'} ${pretty(hit[0].id)}${hit.length > 1 ? ` +${hit.length - 1}` : ''}`, 0); if (ov.hidden) navPing(); }
      } else if (ev.t === 'complete' || ev.t === 'error'){
        if (runWrote && !ov.hidden) load();            // new or changed notes appear without a refresh
        runWrote = false;
        if (actEl && !actEl.hidden && /^◉/.test(actEl.textContent)) chip(actEl.textContent.replace(/^◉ Atlas is (read|writ)ing/, (m, v) => '✓ Atlas ' + (v === 'read' ? 'read' : 'wrote')), 2500);
      }
    } catch (_) {}
    return origBrainHandle(ev);
  };
  async function showBrain(id){
    if (NAV()) for (const k in NAV().views) if (k !== 'brain' && NAV().views[k].close) NAV().views[k].close();
    if (!isOpen()) return open(id);
    const n = id && byId.get(id);
    if (n){ flyTo(n, Math.max(view.k, 1.25)); openNote(n); }
  }
  async function voiceAction(a){
    if (a.action === 'close') return close();
    if (a.action === 'open') return showBrain(a.id);
    await showBrain(a.action === 'isolate' ? a.id : undefined);
    if (a.action === 'isolate' && byId.get(a.id)) setIsolate(a.id, 1);
    else if (a.action === 'search' && searchInput){ searchInput.value = a.q || ''; searchIdx = 0; updateSearch(false); chip(`No note called “${a.q}”. Closest matches are highlighted.`, 4000); }
    else if (a.action === 'timeline'){ selected = null; syncToDept(null); showTimeline(true); }   // let the new notes stand out
  }

  // ══ isolate: a note and its neighbours, 1 or 2 hops ══
  function setIsolate(id, depth = 1, refit = true){
    if (!id || !byId.get(id)){ iso = null; isoSet = null; }
    else {
      iso = {id, depth}; isoSet = new Set([id]); let edge = [id];
      for (let d = 0; d < depth; d++){
        const next = [];
        for (const f of edge) for (const nb of adj.get(f) || []) if (!isoSet.has(nb)){ isoSet.add(nb); next.push(nb); }
        edge = next;
      }
    }
    const b = $b('brIsolate');
    b.setAttribute('aria-pressed', String(!!iso));
    b.textContent = iso ? `Isolate · ${iso.depth} hop${iso.depth > 1 ? 's' : ''}` : 'Isolate';
    renderOutline();
    if (refit) fitTo(nodes.filter(visible), true); else draw();
  }
  const cycleIsolate = () => {
    const n = selected || hover;
    if (!iso){ if (n) setIsolate(n.id, 1); else chip('Select a note first, then isolate it'); }
    else if (iso.depth === 1) setIsolate(iso.id, 2);
    else setIsolate(null);
  };

  // ══ fold a department into its node ══
  function toggleFold(slug){
    if (collapsed.has(slug)) collapsed.delete(slug); else collapsed.add(slug);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...collapsed])); } catch (_) {}
    if (selected && !visible(selected)){ selected = null; syncToDept(null); }
    alpha = Math.max(alpha, .3); legend(); renderOutline();
    if (!raf && !ov.hidden) loop(); else draw();
  }
  $b('brLegend').addEventListener('click', e => { const b = e.target.closest('[data-fold]'); if (b) toggleFold(b.dataset.fold); });

  // ══ arrow keys: hop to the linked note that lies in that direction ══
  function hop(dx, dy){
    const from = selected && visible(selected) ? selected : null;
    if (!from){ const s = byId.get('Atlas') || nodes.find(visible); if (s){ flyTo(s, view.k); openNote(s); } return; }
    const best = list => {
      let b = null, bs = -1e9;
      for (const n of list){
        if (!n || n === from || !visible(n)) continue;
        const vx = n.x - from.x, vy = n.y - from.y, d = Math.hypot(vx, vy) || 1, cos = (vx * dx + vy * dy) / d;
        if (cos < .35) continue;                       // roughly that way
        const s = cos * 1.5 - d / 300;                 // straight ahead first, then nearest
        if (s > bs){ bs = s; b = n; }
      }
      return b;
    };
    const n = best([...(adj.get(from.id) || [])].map(id => byId.get(id))) || best(nodes);
    if (n){ flyTo(n, view.k); openNote(n); }
  }

  // ══ edit in place, with [[ autocomplete ══
  const editor = $b('brEditor'), ac = $b('brAC');
  const editMsg = t => { $b('brEditMsg').textContent = t || ''; };
  let editing = null;                                  // {id, mtime, orig, armed}
  const isDirty = () => !!editing && editor.value !== editing.orig;
  async function startEdit(){
    const n = selected; if (!n || editing) return;
    let r = null;
    try { r = await fetch('/api/brain/note?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(x => x.json()); } catch (_) {}
    if (!r || r.error){ chip('Could not load this note for editing'); return; }
    if (r.editable === false){ chip('This note is too large to edit here'); return; }
    editing = {id: n.id, mtime: r.mtime, orig: r.text, armed: false};
    editor.value = r.text; editor.hidden = false; $b('brEditBar').hidden = false; $b('brText').hidden = true;
    $b('brEdit').setAttribute('aria-pressed', 'true');
    editMsg('⌘S save · Esc cancel · type [[ to link');
    editor.focus(); editor.setSelectionRange(r.text.length, r.text.length);
  }
  function stopEdit(){
    editing = null; editor.hidden = true; ac.hidden = true;
    $b('brEditBar').hidden = true; $b('brText').hidden = false; $b('brEdit').setAttribute('aria-pressed', 'false');
  }
  async function saveEdit(){
    if (!editing) return;
    const {id, mtime} = editing;
    editMsg('Saving…');
    const res = await post('/api/brain/note', {id, text: editor.value, base_mtime: mtime});
    if (!res.ok){
      editMsg(res.status === 409 ? 'This note changed on disk since you opened it. Copy your text, cancel, and edit again.' : (res.error || 'Could not save.'));
      return;
    }
    stopEdit();
    touched.set(id, {at: performance.now(), kind: 'write'});
    await load();
    const n = byId.get(id);
    if (n){ openNote(n); pulseNode(id, 'write'); }
    chip(`✓ Saved ${pretty(id)}`);
  }
  let acItems = [], acSel = 0;
  function acUpdate(){
    const m = /\[\[([^\]\[\n|#]{0,40})$/.exec(editor.value.slice(0, editor.selectionStart));
    if (!m){ ac.hidden = true; return; }
    const q = m[1].toLowerCase().replace(/[-_\s]+/g, ' ').trim();
    const norm = id => id.toLowerCase().replace(/[-_]+/g, ' ');
    acItems = nodes.map(n => n.id).filter(id => !q || norm(id).includes(q))
      .sort((a, b) => (norm(a).startsWith(q) ? 0 : 1) - (norm(b).startsWith(q) ? 0 : 1) || a.length - b.length).slice(0, 7);
    if (!acItems.length){ ac.hidden = true; return; }
    acSel = 0; ac.hidden = false;
    ac.innerHTML = acItems.map((id, i) => `<button type="button" role="option" data-ac="${i}" aria-selected="${i === 0}">${esc(id)}</button>`).join('');
  }
  function acPick(i){
    const id = acItems[i]; if (!id) return;
    const at = editor.selectionStart, start = editor.value.lastIndexOf('[[', at) + 2;
    editor.setRangeText(id + (editor.value.slice(at).startsWith(']]') ? '' : ']]'), start, at, 'end');
    ac.hidden = true; editor.focus();
  }
  editor.addEventListener('input', () => { if (editing) editing.armed = false; acUpdate(); });
  editor.addEventListener('click', acUpdate);
  ac.addEventListener('mousedown', e => { const b = e.target.closest('[data-ac]'); if (b){ e.preventDefault(); acPick(+b.dataset.ac); } });
  editor.addEventListener('keydown', e => {
    e.stopPropagation();                               // keep Space, letters, arrows and Esc away from the mic, shortcuts and graph
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); saveEdit(); return; }
    if (!ac.hidden){
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        acSel = (acSel + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length;
        [...ac.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === acSel)));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); acPick(acSel); return; }
      if (e.key === 'Escape'){ e.preventDefault(); ac.hidden = true; return; }
    }
    if (e.key === 'Escape'){
      e.preventDefault();
      if (isDirty() && !editing.armed){ editing.armed = true; editMsg('Unsaved changes. Esc again to discard, ⌘S to save.'); return; }
      stopEdit();
    }
  });
  $b('brEdit').addEventListener('click', () => (editing ? (isDirty() ? editMsg('Save or cancel first.') : stopEdit()) : startEdit()));
  $b('brEditSave').addEventListener('click', saveEdit);
  $b('brEditCancel').addEventListener('click', stopEdit);

  // ══ new note (linked to the selected one) ══
  const newForm = $b('brNewForm'), newTitle = $b('brNewTitle');
  function newNote(){
    newForm.hidden = false; $b('brNewMsg').textContent = '';
    $b('brNewNear').textContent = selected ? `linked to ${pretty(selected.id)}` : 'linked to Atlas';
    newTitle.value = ''; newTitle.focus();
  }
  newForm.addEventListener('submit', async e => {
    e.preventDefault();
    const title = newTitle.value.trim(); if (!title) return;
    const res = await post('/api/brain/note', {create: title, near: selected ? selected.id : ''});
    if (!res.ok){ $b('brNewMsg').textContent = res.error || 'Could not create the note.'; return; }
    newForm.hidden = true;
    await load();
    const n = byId.get(res.note.id);
    if (n){ nodeSparks.set(n.id, performance.now()); flyTo(n, Math.max(view.k, 1.1)); await openNote(n); startEdit(); }
  });
  newTitle.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape'){ e.preventDefault(); newForm.hidden = true; } });
  $b('brNewCancel').addEventListener('click', () => { newForm.hidden = true; });
  $b('brNew').addEventListener('click', newNote);

  // ══ links: ⇧-drag, or one click on a suggestion ══
  async function linkNotes(a, b){
    const res = await post('/api/brain/link', {source: a, target: b});
    if (!res.ok){ chip(res.error || 'Could not add the link'); return; }
    touched.set(a, {at: performance.now(), kind: 'write'});
    await load(); pulseNode(a, 'write');
    chip(`✓ Linked ${pretty(a)} → ${pretty(b)}`);
    if (selected && (selected.id === a || selected.id === b) && !editing) openNote(selected);
  }
  async function loadSuggest(n){
    const box = $b('brSuggest');
    let s = null;
    try { s = await fetch('/api/brain/suggest?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(r => r.json()); } catch (_) {}
    if (selected !== n || !s || s.error) return;
    const rows = [...(s.mentions || []).map(x => ({src: n.id, dst: x.id, why: 'named here', snip: x.snippet})),
                  ...(s.mentioned_in || []).map(x => ({src: x.id, dst: n.id, why: 'names this note', snip: x.snippet}))].slice(0, 8);
    if (!rows.length){ box.hidden = true; return; }
    box.innerHTML = '<div class="bs-head">Suggested links</div>' + rows.map((r, i) =>
      `<button type="button" class="bs-item" data-i="${i}" title="${escA(r.snip)}"><b>＋</b>${esc(pretty(r.src === n.id ? r.dst : r.src))}<span>${r.why}</span></button>`).join('');
    box.onclick = e => { const b = e.target.closest('[data-i]'); if (!b || b.disabled) return; b.disabled = true; const r = rows[+b.dataset.i]; linkNotes(r.src, r.dst); };
    box.hidden = false;
  }

  // ══ timeline: replay how the brain grew ══
  const tlBar = $b('brTimeline'), tlRange = $b('brTlRange'), tlLabel = $b('brTlLabel'), tlPlay = $b('brTlPlay'), tlFresh = $b('brTlFresh');
  let freshIdx = 0;
  const fmtWhen = (s, span) => new Date(s * 1000).toLocaleString(undefined,
    span < 3 * 86400 ? {weekday: 'short', hour: '2-digit', minute: '2-digit'} : {day: 'numeric', month: 'short', year: 'numeric'});
  function tlSync(){
    if (!tl.on) return;
    const span = tl.t1 - tl.t0, fr = nodes.filter(fresh);
    tlRange.value = String(Math.round(((tl.t - tl.t0) / (span || 1)) * 1000));
    tlLabel.textContent = `${fmtWhen(tl.t, span)} · ${nodes.filter(n => typeOn(n) && (!n.born || n.born <= tl.t)).length} notes`;
    tlFresh.textContent = fr.length ? `${fr.length} new that week ▸` : 'nothing new that week';
    tlFresh.disabled = !fr.length;
    tlPlay.textContent = tl.playing ? '❚❚' : '▶'; tlPlay.setAttribute('aria-label', tl.playing ? 'Pause' : 'Play');
  }
  function showTimeline(on){
    const b = $b('brTimelineBtn');
    if (!on){ tl.on = tl.playing = false; tlBar.hidden = true; b.setAttribute('aria-pressed', 'false'); renderOutline(); draw(); return; }
    const ts = nodes.map(n => n.born).filter(Boolean);
    if (!ts.length){ chip('No dates found on these notes'); return; }
    Object.assign(tl, {on: true, playing: false, t0: Math.min(...ts) - 60, t1: Math.max(Date.now() / 1000, ...ts)});
    tl.t = tl.t1; freshIdx = 0;
    tlBar.hidden = false; b.setAttribute('aria-pressed', 'true');
    tlSync(); renderOutline(); draw();
    if (!raf && !ov.hidden) loop();
  }
  function tickTimeline(now){
    const before = tl.t;
    tl.t = Math.min(tl.t1, tl.t + (tl.t1 - tl.t0) * Math.min(250, now - tl.last) / 9000);   // whole history in ~9s
    tl.last = now;
    for (const n of nodes) if (n.born > before && n.born <= tl.t) nodeSparks.set(n.id, now);
    if (tl.t >= tl.t1) tl.playing = false;
    tlSync();
  }
  tlPlay.addEventListener('click', () => {
    if (!tl.playing && tl.t >= tl.t1) tl.t = tl.t0;
    tl.playing = !tl.playing; tl.last = performance.now(); tlSync();
    if (!raf && !ov.hidden) loop();
  });
  tlRange.addEventListener('input', () => { tl.playing = false; tl.t = tl.t0 + (tl.t1 - tl.t0) * (+tlRange.value / 1000); tlSync(); renderOutline(); draw(); });
  tlFresh.addEventListener('click', () => { const fr = nodes.filter(fresh); if (!fr.length) return; const n = fr[freshIdx++ % fr.length]; flyTo(n, Math.max(view.k, 1.1)); openNote(n); });
  $b('brTlClose').addEventListener('click', () => showTimeline(false));
  $b('brTimelineBtn').addEventListener('click', () => showTimeline(!tl.on));
  $b('brIsolate').addEventListener('click', cycleIsolate);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !ov.hidden && !raf) loop();
  });

  const navBtn = $b('navBrain'), isOpen = () => !ov.hidden;
  const open = async arg => {
    const want = arg && typeof arg === 'string' ? arg : arg && arg.id;
    // reset every piece of transient interaction state so nothing survives a close/reopen
    hover = null; selected = null; drag = null; pan = null; flyAnim = null; moved = false;
    downId = null; pointerIn = false; lastPX = lastPY = null; viewSaved = null; linkDrag = null;
    iso = null; isoSet = null; $b('brIsolate').setAttribute('aria-pressed', 'false'); $b('brIsolate').textContent = 'Isolate';
    tl.on = tl.playing = false; tlBar.hidden = true; $b('brTimelineBtn').setAttribute('aria-pressed', 'false');
    ov.hidden = false; navBtn.setAttribute('aria-expanded', 'true'); fit(); view = {x: 0, y: 0, k: 1};
    await load(); fitView(); cancelAnimationFrame(raf); setCursor(); loop();
    if (editing && byId.get(editing.id)) selected = byId.get(editing.id);   // an unsaved edit survives close / reopen
    const n = want && byId.get(want);
    if (n){                                           // jump to a specific note (e.g. from Departments)
      flyTo(n, 1.25); openNote(n);
    }
  };
  const close = () => {
    ov.hidden = true; navBtn.setAttribute('aria-expanded', 'false'); cancelAnimationFrame(raf); raf = 0;
    hover = null; drag = null; pan = null; flyAnim = null; moved = false; downId = null; pointerIn = false;
    linkDrag = null; tl.playing = false;
  };
  window.AtlasBrain = {
    open, close, load,
    flyTo: id => { const n = byId.get(id); if (n){ flyTo(n, 1.3); openNote(n); } },
    pulseNode,
    // Read-only introspection (used by tests/automation): the exact screen position of a node in
    // CSS px relative to the canvas, using the SAME transform draw() paints with.
    screenOf: id => { const n = byId.get(id); return n ? toScreen(n.x, n.y) : null; },
    pickAt: (px, py) => { const n = pick(px, py); return n ? n.id : null; },   // canvas CSS px → node id
    nodeIds: () => nodes.filter(visible).map(n => n.id),
    labelShown: id => { const n = byId.get(id); return !!(n && labelVisible(n)); },
    labelOf: id => { const n = byId.get(id); return (n && labelVisible(n)) ? labelBand(n) : null; },
    selectedId: () => (selected ? selected.id : null),
    hoverId: () => (hover ? hover.id : null),
    viewInfo: () => ({x: view.x, y: view.y, k: view.k, W, H, dpr}),
    ready: () => nodes.length > 0,
    settled: () => alpha <= 0.021 && !drag && !pan && !flyAnim,   // forces have stopped, nodes still
    voice: a => voiceAction(a),
    isolate: (id, depth) => setIsolate(id, depth || 1),
    fold: slug => toggleFold(slug),
    timeline: on => showTimeline(on !== false),
    hop: (dx, dy) => hop(dx, dy),
    link: (a, b) => linkNotes(a, b),
    state: () => ({iso: iso && {...iso}, timeline: tl.on, t: tl.t, folded: [...collapsed], editing: editing && editing.id,
                   visible: nodes.filter(visible).length, touched: [...touched.keys()]}),
  };
  const NAV = () => window.AtlasNav;
  const goDept = () => {                              // the selected note's department / team, if it belongs to one
    const n = selected; if (!n || !NAV()) return;
    const d = n.type === 'dept' ? n.id : n.group;
    const team = n.type === 'sub' ? n.id : n.type === 'notebook' ? n.id.replace(/-notebook$/, '') : null;
    NAV().go('departments', {dept: d, team: AtlasData.dept(d)?.teams.some(t => t.slug === team) ? team : null});
  };
  const syncToDept = n => {
    const b = $b('brToDept'), ok = n && (n.type === 'dept' || n.type === 'sub' || n.type === 'notebook') && n.group && AtlasData.dept(n.group);
    b.hidden = !ok;
    if (ok) b.textContent = 'Open ' + (AtlasData.dept(n.group).name) + ' in Departments ▸';
  };
  $b('brToDept').addEventListener('click', goDept);
  if (window.AtlasNav) AtlasNav.views.brain = {open, close, isOpen};
  const tabs = document.createElement('div'); tabs.innerHTML = window.AtlasNav ? AtlasNav.tabs('brain') : '';
  if (tabs.firstElementChild) ov.querySelector('.rhead > span').after(tabs.firstElementChild);
  navBtn.addEventListener('click', () => isOpen() ? close() : (NAV() ? NAV().go('brain') : open()));
  $b('brainClose').addEventListener('click', close);
  $b('brRefresh').addEventListener('click', load);
  document.addEventListener('keydown', e => {
    if (ov.hidden) return;
    const el = document.activeElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || el?.isContentEditable;
    if (e.key === 'Escape'){                           // peel one layer at a time
      if (linkDrag){ endPointer(); draw(); }
      else if (!newForm.hidden) newForm.hidden = true;
      else if (iso) setIsolate(null);
      else if (tl.on) showTimeline(false);
      else if (selected){ selected = null; syncToDept(null); draw(); }
      else close();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const d = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key];
    if (d){ if (el === $b('brText')) return; e.preventDefault(); hop(d[0], d[1]); return; }
    const act = {f: () => fitTo(nodes.filter(visible), true), x: cycleIsolate, l: () => showTimeline(!tl.on),
                 e: () => startEdit(), n: newNote, '/': () => searchInput && searchInput.focus()}[e.key.toLowerCase()];
    if (act){ e.preventDefault(); act(); }
  });
  [$b('brNotebooks'), $b('brShared')].forEach(c => c.addEventListener('change', () => { alpha = 1; }));
})();

// ══════════ reading toolbar for the Brain note panel ══════════
// Font size (persisted), focus / reading mode, fullscreen, copy and download.
// Appended as its own IIFE so the transmit / voice logic is untouched.
(() => {
  const panel = document.getElementById('brainOverlay');
  const noteEl = document.getElementById('brText');
  if (!panel || !noteEl) return;

  // ── A- / A+ text size, remembered across sessions ──
  const KEY = 'jarvis.mdScale';
  const MIN = 0.8, MAX = 1.9, STEP = 0.1;
  const clamp = v => Math.max(MIN, Math.min(MAX, Math.round(v * 100) / 100));
  let scale = 1;
  try { const s = parseFloat(localStorage.getItem(KEY)); if (Number.isFinite(s)) scale = clamp(s); } catch (_) {}
  const applyScale = () => {
    noteEl.style.setProperty('--md-scale', String(scale));
    try { localStorage.setItem(KEY, String(scale)); } catch (_) {}
  };
  applyScale();
  const dec = document.getElementById('brFontDec');
  const inc = document.getElementById('brFontInc');
  if (dec) dec.addEventListener('click', () => { scale = clamp(scale - STEP); applyScale(); });
  if (inc) inc.addEventListener('click', () => { scale = clamp(scale + STEP); applyScale(); });

  // ── focus / reading mode ──
  const focusBtn = document.getElementById('brFocus');
  const setFocus = on => {
    document.body.classList.toggle('reading-focus', on);
    if (focusBtn) focusBtn.setAttribute('aria-pressed', String(on));
  };
  if (focusBtn) focusBtn.addEventListener('click', () => setFocus(!document.body.classList.contains('reading-focus')));

  // ── fullscreen ──
  const fullBtn = document.getElementById('brFull');
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  const exitFs = () => { const f = document.exitFullscreen || document.webkitExitFullscreen; if (f) f.call(document); };
  if (fullBtn) fullBtn.addEventListener('click', () => {
    const target = document.querySelector('.brain-note') || noteEl;
    if (fsEl()) { exitFs(); return; }
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (req) { const p = req.call(target); if (p && p.catch) p.catch(() => {}); }
  });
  const onFs = () => { if (fullBtn) fullBtn.setAttribute('aria-pressed', String(!!fsEl())); };
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);

  const flash = (el, text) => {
    if (!el) return;
    const old = el.textContent; el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 1200);
  };

  // ── copy the raw markdown ──
  const copyBtn = document.getElementById('brCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const raw = noteEl._raw || '';
    if (!raw) { flash(copyBtn, 'Empty'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(raw);
      } else {
        const ta = document.createElement('textarea');
        ta.value = raw; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      flash(copyBtn, 'Copied');
    } catch (_) { flash(copyBtn, 'Copy failed'); }
  });

  // ── download the note as a .md file ──
  const dlBtn = document.getElementById('brDownload');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    const raw = noteEl._raw || '';
    if (!raw) return;
    const id = String(noteEl._noteId || 'note').replace(/[^A-Za-z0-9._-]+/g, '-') || 'note';
    const url = URL.createObjectURL(new Blob([raw], {type: 'text/markdown;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url; a.download = id + '.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // leaving the brain clears reading mode so the graph is never left dimmed
  new MutationObserver(() => {
    if (panel.hidden) { setFocus(false); if (fsEl()) exitFs(); }
  }).observe(panel, {attributes: true, attributeFilter: ['hidden']});
})();
