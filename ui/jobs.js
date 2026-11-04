// ══════════ IIFE · Jobs & Activity tab (handoff missions, /background jobs, POD & Inbox) ══════════
(() => {
  'use strict';
  const ov = document.getElementById('jobsOverlay'); if (!ov) return;
  const navBtn = document.getElementById('navJobs');
  const body = document.getElementById('jaBody');
  const sum = document.getElementById('jaSum');
  const tabs = document.getElementById('jaTabs');
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));

  let tab = 'all', state = {running: 0, agents: [], missions: [], inbox: [], pod: []}, timer = null;

  const dur = s => {
    if (s == null) return '—';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`;
  };
  const clock = t => t ? new Date(t * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '—';

  function updateBadge(){
    if (!navBtn) return;
    const n = state.running || 0;
    navBtn.dataset.count = n ? String(n) : '';
  }

  function renderJobCard(a){
    const running = a.status === 'running' || a.status === 'stalled';
    return `<article class="ag-card st-${esc(a.status || 'done')}" data-id="${esc(a.id || '')}">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(a.name || a.mission || 'Mission')}</b>
        <span class="ag-tag">${esc(a.kind || 'handoff')}</span>
        <span class="ag-status">${esc(a.status || 'done')}</span></header>
      <div class="ag-brief">${esc((a.brief || a.mission || '').slice(0, 240))}</div>
      ${running && a.step ? `<div class="ag-step"><span class="ag-k">Live step</span><span class="ag-v">${esc(a.step)}</span></div>` : ''}
      ${!running && a.result ? `<div class="ag-result"><span class="ag-k">Outcome</span><div class="ag-rtext">${esc(a.result)}</div></div>` : ''}
      <div class="ag-meta"><span>Started <b>${esc(clock(a.started || a.at))}</b></span>
        ${a.elapsed != null ? `<span>Duration <b>${esc(dur(a.elapsed))}</b></span>` : ''}
        <span class="ag-id">${esc(a.id || '')}</span></div>
    </article>`;
  }

  function renderInboxCard(it){
    const tr = it.triage || {};
    return `<article class="ag-card st-done" data-id="${esc(it.id)}">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(it.name)}</b>
        <span class="ag-tag">inbox · ${esc(it.kind || 'file')}</span>
        <span class="ag-status">${esc(it.status || 'new')}</span></header>
      ${it.preview ? `<div class="ag-brief md-read md-compact">${window.AtlasMarkdown ? AtlasMarkdown.render(it.preview.slice(0, 200)) : esc(it.preview.slice(0, 200))}</div>` : ''}
      <div class="ag-meta"><span>Saved <b>${esc(clock(it.created))}</b></span>
        <span>Dept <b>${esc(tr.department || '—')}</b></span>
        <button type="button" class="ag-more" data-open-brain="${esc(it.note_id || it.id)}">Open in Brain ▸</button></div>
    </article>`;
  }

  function renderPodCard(p){
    return `<article class="ag-card st-done">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(p.name || p.id || 'POD item')}</b>
        <span class="ag-tag">POD</span>
        <span class="ag-status">${esc(p.verdict || p.path || 'note')}</span></header>
      <div class="ag-brief md-read md-compact">${window.AtlasMarkdown ? AtlasMarkdown.render((p.preview || p.summary || '').slice(0, 240)) : esc((p.preview || p.summary || '').slice(0, 240))}</div>
      <div class="ag-meta">
        ${p.score != null ? `<span>Score <b>${esc(p.score)}/100</b></span>` : ''}
        <button type="button" class="ag-more" data-open-brain="${esc(p.id || 'pod-idea-queue')}">Open in Brain ▸</button>
      </div>
    </article>`;
  }

  function render(){
    updateBadge();
    const agents = state.agents || [];
    const inb = state.inbox || [];
    const pod = state.pod || [];
    if (sum) sum.textContent = `${state.running || 0} running · ${agents.length} missions · ${inb.length} inbox · ${pod.length} POD`;

    let html = '';
    if (tab === 'all' || tab === 'jobs'){
      const running = agents.filter(a => a.status === 'running' || a.status === 'stalled');
      const done = agents.filter(a => !(a.status === 'running' || a.status === 'stalled'));
      html += `<div class="ag-sec">Running Handoff &amp; Background Missions (${running.length})</div>`;
      html += running.length ? `<div class="ag-grid">${running.map(renderJobCard).join('')}</div>` : '<div class="pal-empty">No missions running right now.</div>';
      html += `<div class="ag-sec">Completed &amp; Recent Missions (${done.length})</div>`;
      html += done.length ? `<div class="ag-grid">${done.map(renderJobCard).join('')}</div>` : '<div class="pal-empty">No completed missions recorded yet.</div>';
    }
    if (tab === 'all' || tab === 'pod'){
      html += `<div class="ag-sec">Recent Inbox Drops (${inb.length})</div>`;
      html += inb.length ? `<div class="ag-grid">${inb.map(renderInboxCard).join('')}</div>` : '<div class="pal-empty">No items in ~/Atlas/inbox yet.</div>';
      html += `<div class="ag-sec">POD Scorecard &amp; Reviews (${pod.length})</div>`;
      html += pod.length ? `<div class="ag-grid">${pod.map(renderPodCard).join('')}</div>` : '<div class="pal-empty">No POD notes found yet.</div>';
    }
    body.innerHTML = html;
  }

  async function refresh(){
    try {
      const r = await fetch('/api/activity', {headers: apiHeaders(), cache: 'no-store'}).then(r => r.json());
      if (r && Array.isArray(r.agents)){
        state = r;
        render();
      }
    } catch (_) {}
  }

  tabs?.addEventListener('click', e => {
    const b = e.target.closest('[data-jatab]'); if (!b) return;
    tab = b.dataset.jatab;
    tabs.querySelectorAll('[data-jatab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    render();
  });

  body?.addEventListener('click', e => {
    const b = e.target.closest('[data-open-brain]'); if (!b) return;
    const noteId = b.dataset.openBrain;
    close();
    if (window.AtlasNav) AtlasNav.go('brain', noteId);
  });

  function open(){
    ov.hidden = false;
    navBtn?.setAttribute('aria-expanded', 'true');
    document.getElementById('scrim')?.click();
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!ov.hidden && !document.hidden) refresh(); }, 3500);
  }
  function close(){
    ov.hidden = true;
    navBtn?.setAttribute('aria-expanded', 'false');
    clearInterval(timer); timer = null;
  }

  navBtn?.addEventListener('click', () => ov.hidden ? (window.AtlasNav ? AtlasNav.go('jobs') : open()) : close());
  document.getElementById('jaClose')?.addEventListener('click', close);
  document.getElementById('jaRefresh')?.addEventListener('click', refresh);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden){ e.stopPropagation(); close(); } }, true);

  if (window.AtlasNav) AtlasNav.views.jobs = {open, close, isOpen: () => !ov.hidden};
  window.AtlasJobs = {open, close, refresh};
  refresh();
})();
