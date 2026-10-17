/* Atlas · Departments view — three switchable layouts (grid · sidebar · orbit).
   Data: window.AtlasData (atlas-data.js — loaded from /api/departments, with a built-in fallback).
   Self-contained overlay; styles live in departments.css and use theme variables only.
   Linked to the Brain view through window.AtlasNav (open the matching notes / come back from a note). */
(() => {
  'use strict';
  const AD = window.AtlasData, NAV = window.AtlasNav;
  // [slug, name, remit, colour variable, sub-teams [slug, name, remit]] — rebuilt from AtlasData on every render
  let D = [], byId = {};
  const sync = () => {
    D = AD.depts.map(d => [d.slug, d.name, d.remit, AD.colorVar(d.slug), d.teams.map(t => [t.slug, t.name, t.remit])]);
    byId = Object.fromEntries(D.map(d => [d[0], d]));
    if (!byId[sel.dept]) sel = {dept: D[0] ? D[0][0] : null, team: null};
    else if (sel.team && !byId[sel.dept][4].some(t => t[0] === sel.team)) sel.team = null;
  };
  const VIEWS = [['grid', 'Grid'], ['sidebar', 'Sidebar'], ['orbit', 'Orbit']];
  const KEY = 'jarvis.deptview';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  let view = 'grid', sel = {dept: null, team: null};
  try { const v = localStorage.getItem(KEY); if (VIEWS.some(x => x[0] === v)) view = v; } catch (_) {}
  const h = /deptview=([a-z]+)/.exec(location.hash); if (h && VIEWS.some(x => x[0] === h[1])) view = h[1];

  // ── shell ──
  const ov = document.createElement('div');
  ov.id = 'deptOverlay'; ov.className = 'dept-overlay'; ov.hidden = true;
  ov.innerHTML = `<div class="dept-panel glass" role="dialog" aria-label="Departments">
    <div class="rhead"><span>Atlas workspace</span>${NAV ? NAV.tabs('departments') : ''}
      <div class="dept-switch" role="group" aria-label="Layout">${VIEWS.map(([id, n]) =>
        `<button type="button" data-view="${id}"><i class="dv-ico dv-${id}"></i><span>${n}</span></button>`).join('')}</div>
      <button class="ctl aux" id="deptClose" aria-label="Close departments">✕</button></div>
    <div class="dept-body" id="deptBody"></div></div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector('#deptBody');

  const state = id => {                       // live status borrowed from the department rail
    const el = document.querySelector(`#teamRail .tr-item[data-dept="${id}"]`);
    return el ? (el.classList.contains('working') ? 'working' : el.classList.contains('done') ? 'done' : '') : '';
  };
  const dot = id => `<span class="dp-state ${state(id)}" title="${state(id) || 'idle'}"></span>`;
  const cv = d => `style="--c:var(${d[3]})"`;

  function brief(slug, name){
    const inp = document.getElementById('input'); close();
    if (!inp) return;
    inp.value = `Brief the ${slug} team (${name}): `; inp.focus();
    inp.dispatchEvent(new Event('input', {bubbles: true}));
  }
  const briefBtn = (slug, name) => `<button type="button" class="ctl run dp-brief" data-brief="${slug}" data-name="${esc(name)}">Brief ${esc(name)} ▸</button>`;
  const brainBtn = (id, label) => `<button type="button" class="ctl aux dp-brain" data-brain="${id}">${label} ▸</button>`;

  // ── layout 1: grid of department cards ──
  const gridView = () => `<div class="dp-grid">${D.map(d => `
    <article class="dp-card" ${cv(d)}>
      <header><span class="dp-dot"></span><h3>${esc(d[1])}</h3>${dot(d[0])}<em>${d[4].length} teams</em></header>
      <p>${esc(d[2])}</p>
      <ul>${d[4].map(t => `<li><button type="button" data-brief="${t[0]}" data-name="${esc(t[1])}" title="Brief ${esc(t[1])}: ${esc(t[2])}">
        <b>${esc(t[1])}</b><span>${esc(t[2])}</span></button></li>`).join('')}</ul>
      <footer><button type="button" class="dp-link" data-brief="${d[0]}" data-name="${esc(d[1])}">Brief whole department ▸</button>
        <button type="button" class="dp-link" data-brain="${d[0]}">Notes in Brain ▸</button></footer>
    </article>`).join('')}</div>`;

  // ── detail pane (sidebar + orbit) ──
  function detail(){
    const d = byId[sel.dept]; if (!d) return '';
    const t = sel.team && d[4].find(x => x[0] === sel.team);
    const head = t ? `<div class="dd-crumb"><button type="button" data-pick="${d[0]}">${esc(d[1])}</button> / ${esc(t[1])}</div>
        <h2>${esc(t[1])}</h2><p class="dd-remit">${esc(t[2])}</p>
        <div class="dd-meta"><span>team</span><code>${t[0]}</code><span>dept</span><code>${d[0]}</code></div>
        <div class="dd-actions">${briefBtn(t[0], t[1])}${brainBtn(t[0], 'View in Brain')}</div>`
      : `<div class="dd-crumb">Department ${dot(d[0])}</div><h2>${esc(d[1])}</h2><p class="dd-remit">${esc(d[2])}</p>
        <div class="dd-meta"><span>folder</span><code>${d[0]}</code><span>teams</span><code>${d[4].length}</code></div>
        <div class="dd-actions">${briefBtn(d[0], d[1])}${brainBtn(d[0], 'View in Brain')}</div>`;
    return `<aside class="dp-detail" ${cv(d)}>${head}
      <div class="dd-label">Sub-teams</div>
      <ul class="dd-list">${d[4].map(x => `<li><button type="button" class="${x[0] === sel.team ? 'on' : ''}" data-team="${x[0]}">
        <b>${esc(x[1])}</b><span>${esc(x[2])}</span></button></li>`).join('')}</ul>
      <div class="dd-label">Note</div>
      <div class="dd-note md-read md-compact" data-note="${t ? t[0] : d[0]}"></div></aside>`;
  }

  // ── layout 2: sidebar + detail ──
  const sidebarView = () => `<div class="dp-side"><nav class="ds-nav">${D.map(d => `
      <button type="button" class="${d[0] === sel.dept ? 'on' : ''}" data-pick="${d[0]}" ${cv(d)}>
        <span class="dp-dot"></span><span class="ds-name">${esc(d[1])}</span>${dot(d[0])}<em>${d[4].length}</em></button>`).join('')}</nav>
    <section class="ds-main">${detail()}</section></div>`;

  // ── layout 3: orbit map ──
  function orbitView(){
    const W = 1120, H = 760, cx = W / 2, cy = H / 2 + 6, R = 270, rad = a => a * Math.PI / 180, step = 360 / Math.max(1, D.length);
    let ring = '', lines = '', nodes = '';
    const orbs = D.map((d, i) => {
      const a = -90 + i * step;
      return {d, a, x: cx + R * Math.cos(rad(a)), y: cy + 240 * Math.sin(rad(a))};
    });
    for (const o of orbs){
      const {d} = o, n = d[4].length, spread = n > 5 ? 250 : n === 3 ? 90 : 100, on = d[0] === sel.dept;   // fans outward, away from the hub
      let sub = '';
      d[4].forEach((t, k) => {
        const aa = o.a + (n === 1 ? 0 : -spread / 2 + spread * k / (n - 1));
        const r = n > 5 ? 128 : 108;
        const x = o.x + r * Math.cos(rad(aa)), y = o.y + r * 0.9 * Math.sin(rad(aa));
        const act = on && t[0] === sel.team, anchor = Math.cos(rad(aa)) > .25 ? 'start' : Math.cos(rad(aa)) < -.25 ? 'end' : 'middle';
        const lx = x + (anchor === 'start' ? 12 : anchor === 'end' ? -12 : 0), ly = y + (anchor === 'middle' ? (Math.sin(rad(aa)) > 0 ? 24 : -15) : 4);
        lines += `<line x1="${o.x.toFixed(1)}" y1="${o.y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ob-spoke" style="--c:var(${d[3]})"/>`;
        sub += `<g class="ob-sub ${act ? 'on' : ''}" data-team="${t[0]}" data-dept="${d[0]}" style="--c:var(${d[3]})" tabindex="0" role="button" aria-label="${esc(t[1])}">
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${act ? 9 : 6.5}"/>
          <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(t[1])}</text></g>`;
      });
      ring += `<line x1="${cx}" y1="${cy}" x2="${o.x.toFixed(1)}" y2="${o.y.toFixed(1)}" class="ob-arm"/>`;
      nodes += `${sub}<g class="ob-dept ${on ? 'on' : ''}" data-pick="${d[0]}" style="--c:var(${d[3]})" tabindex="0" role="button" aria-label="${esc(d[1])}">
        <circle class="halo" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="40"/><circle class="core" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="26"/>
        <text x="${o.x.toFixed(1)}" y="${(o.y + 4).toFixed(1)}" text-anchor="middle" class="ob-ini">${d[4].length}</text>
        <text x="${o.x.toFixed(1)}" y="${(o.y - 36).toFixed(1)}" text-anchor="middle" class="ob-name">${esc(d[1])}</text></g>`;
    }
    return `<div class="dp-orbit"><div class="ob-scroll"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="Department orbit map">
      <ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="240" class="ob-ring"/><ellipse cx="${cx}" cy="${cy}" rx="${R * 1.45}" ry="${240 * 1.45}" class="ob-ring faint"/>
      ${ring}${lines}
      <g class="ob-hub"><circle cx="${cx}" cy="${cy}" r="48"/><circle cx="${cx}" cy="${cy}" r="62" class="pulse"/>
        <text x="${cx}" y="${cy + 5}" text-anchor="middle">ATLAS</text></g>${nodes}</svg></div>${detail()}</div>`;
  }

  function render(){
    sync();
    ov.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    ov.dataset.view = view;
    const keep = body.scrollTop;
    body.innerHTML = view === 'sidebar' ? sidebarView() : view === 'orbit' ? orbitView() : gridView();
    body.scrollTop = keep;
    const ob = body.querySelector(".ob-scroll"); if (ob && !keep) ob.scrollLeft = (ob.scrollWidth - ob.clientWidth) / 2;
    body.querySelector(".ds-nav .on")?.scrollIntoView({block: "nearest", inline: "center"});
    const noteHost = body.querySelector('.dd-note');
    if (noteHost) loadNote(noteHost, noteHost.dataset.note);
  }

  // ── rendered markdown note for the selected department / team (Brain note) ──
  const noteCache = new Map();
  let noteReq = 0;
  async function loadNote(host, slug){
    if (!host || !slug) return;
    const token = ++noteReq;
    if (noteCache.has(slug)){ host.innerHTML = noteCache.get(slug); return; }
    host.innerHTML = '<p class="md-p md-loading">loading…</p>';
    try {
      const r = await fetch('/api/brain/note?id=' + encodeURIComponent(slug), {headers: apiHeaders()}).then(r => r.json());
      if (token !== noteReq || !host.isConnected) return;
      const text = r.text || r.error || '';
      const html = window.AtlasMarkdown ? AtlasMarkdown.render(text) : esc(text);
      noteCache.set(slug, html);
      host.innerHTML = html;
    } catch (_) {
      if (token === noteReq) host.innerHTML = '<p class="md-p">could not load note</p>';
    }
  }
  function setView(v){ view = v; try { localStorage.setItem(KEY, v); } catch (_) {} render(); }

  ov.addEventListener('click', e => {
    if (e.target === ov) return close();
    const t = e.target.closest('button, [data-pick], [data-team]'); if (!t) return;
    if (t.id === 'deptClose') return close();
    if (t.dataset.view) return setView(t.dataset.view);
    if (t.dataset.brief) return brief(t.dataset.brief, t.dataset.name);
    if (t.dataset.brain) return NAV ? NAV.go('brain', t.dataset.brain) : undefined;      // team and department slugs are note names
    if (t.dataset.pick){ sel = {dept: t.dataset.pick, team: null}; return render(); }
    if (t.dataset.team){ sel = {dept: t.dataset.dept || sel.dept, team: t.dataset.team}; return render(); }
  });
  // [[wikilinks]] inside a rendered department note jump to that node in the Brain
  body.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a.md-wikilink');
    if (!a) return;
    e.preventDefault();
    if (NAV) NAV.go('brain', a.dataset.node);
  });
  ov.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button]')){ e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', {bubbles: true})); }
  });
  const btn = document.getElementById('navDepts');
  function open(arg){
    sync();
    if (arg && arg.dept && byId[arg.dept]) sel = {dept: arg.dept, team: arg.team || null};
    // grid has no detail pane — a requested team/department selection needs the sidebar layout
    if (arg && arg.dept && view === 'grid') view = 'sidebar';
    ov.hidden = false; render(); btn?.setAttribute('aria-expanded', 'true');
    (ov.querySelector('[aria-pressed=true]') || ov).focus?.();
  }
  function close(){ ov.hidden = true; btn?.setAttribute('aria-expanded', 'false'); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden){ e.stopPropagation(); close(); } }, true);

  if (btn) btn.addEventListener('click', () => ov.hidden ? (NAV ? NAV.go('departments') : open()) : close());
  if (NAV) NAV.views.departments = {open, close, isOpen: () => !ov.hidden};
  // keep status dots live while the view is open; re-render when the department list changes
  const rail = document.getElementById('teamRail');
  if (rail) new MutationObserver(() => { if (!ov.hidden) render(); }).observe(rail, {subtree: true, attributes: true, attributeFilter: ['class']});
  AD.onChange(() => { if (!ov.hidden) render(); });
  window.AtlasDepartments = {open, close, setView};
  if (/deptview=/.test(location.hash)) open();
})();
