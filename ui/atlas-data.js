/* Atlas · shared department data + cross-view navigation.
   One source of truth for the department rail, the Departments view and the Brain graph.
   Data comes from GET /api/departments (read-only, backed by ~/Atlas/departments); until it answers the list
   is empty, so nobody else's departments are ever shown. Colours are theme CSS variables, never hex, so every theme restyles them. */
(() => {
  'use strict';
  const VARS = ['--dept-1', '--dept-2', '--dept-3', '--dept-4', '--dept-5'];   // per-theme department hues (themes.css), assigned by position
  const subs = [];
  const D = {
    source: 'none',
    depts: [],
    colorVar(slug){ const i = this.depts.findIndex(d => d.slug === slug); return VARS[(i < 0 ? 0 : i) % VARS.length]; },
    dept(slug){ return this.depts.find(d => d.slug === slug); },
    deptOfTeam(team){ return this.depts.find(d => d.teams.some(t => t.slug === team)); },
    onChange(fn){ subs.push(fn); },
    async load(){
      try {
        const h = typeof apiHeaders === 'function' ? apiHeaders() : {};
        const r = await fetch('/api/departments', {headers: h}).then(r => r.json());
        const list = (r.departments || []).filter(d => d && d.slug && Array.isArray(d.teams));
        if (!list.length) return;
        if (JSON.stringify(list) === JSON.stringify(this.depts)) { this.source = 'files'; return; }
        this.depts = list; this.source = 'files';
        subs.forEach(fn => { try { fn(list); } catch (_) {} });
      } catch (_) { /* keep what we have */ }
    },
  };
  window.AtlasData = D;

  // ── navigation between the two views (each registers itself as AtlasNav.views.<name>) ──
  const views = {};
  window.AtlasNav = {
    views,
    // go('departments', {dept, team}) | go('brain', {id}) — closes the other view first
    go(name, arg){
      for (const k in views) if (k !== name) views[k].close && views[k].close();
      views[name] && views[name].open(arg);
    },
  };
  // shared header switcher so both views read as one section
  window.AtlasNav.tabs = active => `<div class="view-tabs" role="tablist" aria-label="Departments and Brain">
    ${[['departments', 'Departments'], ['brain', 'Brain']].map(([id, n]) =>
      `<button type="button" role="tab" data-nav="${id}" aria-selected="${id === active}">${n}</button>`).join('')}</div>`;
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-nav]');
    if (b) window.AtlasNav.go(b.dataset.nav);
  });
  document.addEventListener('DOMContentLoaded', () => D.load());   // after app.js has defined apiHeaders (a 0ms timer could fire first → 401)
  // deep link: #open=brain&focus=pricing  /  #open=departments&dept=finance  (combine with #theme=…&mode=…)
  setTimeout(() => {
    const h = location.hash, m = /open=(brain|departments)/.exec(h); if (!m) return;
    const f = /focus=([a-z0-9-]+)/.exec(h), d = /dept=([a-z0-9-]+)/.exec(h);
    window.AtlasNav.go(m[1], m[1] === 'brain' ? (f && f[1]) : (d && {dept: d[1], team: f && f[1]}) || undefined);
  }, 50);
})();
