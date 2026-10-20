// Atlas · Agents live activity view: polls /api/agents (loopback + token); Stop asks /api/agents/stop.
(() => {
  const TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content || '';
  const btn = document.getElementById('navAgents');
  if (!btn) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  const ov = document.createElement('div');
  ov.className = 'agents-overlay'; ov.id = 'agentsOverlay'; ov.hidden = true;
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Agents');
  ov.innerHTML = `<div class="agents-panel glass">
    <div class="rhead"><span>Agents</span><span class="ag-sum" id="agSum">—</span>
      <span class="ag-live" id="agLive">LIVE · every 2s</span>
      <button id="agClose" class="ctl aux" aria-label="Close agents">✕</button></div>
    <div class="agents-body" id="agBody"><div class="ag-empty">Loading…</div></div></div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector('#agBody'), sum = ov.querySelector('#agSum'), live = ov.querySelector('#agLive');

  let data = null, timer = null, fetchedAt = 0, expanded = new Set(), lastErr = '';
  const armed = new Set(), stopping = new Set();      // two clicks to stop: arm, then confirm

  const dur = s => {
    if (s == null) return '—';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`;
  };
  const clock = t => t ? new Date(t * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '—';
  const LABEL = {running: 'Running', done: 'Done', failed: 'Failed', stalled: 'Stalled', stopped: 'Stopped'};

  function card(a){
    const running = a.status === 'running' || a.status === 'stalled';
    const dt = running ? (Date.now() - fetchedAt) / 1000 : 0;   // server elapsed + time since that poll
    const el = a.elapsed == null ? null : a.elapsed + dt;
    const open = expanded.has(a.id);
    const long = a.brief.length > 180;
    return `<article class="ag-card st-${esc(a.status)}${a.diagnostic ? ' diag' : ''}" data-id="${esc(a.id)}">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(a.name)}</b>
        ${a.diagnostic ? '<span class="ag-tag">diagnostic</span>' : ''}
        <span class="ag-status">${esc(LABEL[a.status] || a.status)}</span>
        ${running ? `<button type="button" class="ag-stop${armed.has(a.id) ? ' armed' : ''}" data-stop="${esc(a.id)}"
          ${stopping.has(a.id) ? 'disabled' : ''}>${stopping.has(a.id) ? 'Stopping…' : armed.has(a.id) ? 'Confirm stop' : 'Stop'}</button>` : ''}</header>
      <div class="ag-brief${open ? ' open' : ''}">${esc(open || !long ? a.brief : a.brief.slice(0, 180) + '…')}</div>
      ${running ? `<div class="ag-step"><span class="ag-k">${a.status === 'stalled' ? 'Last seen' : 'Now'}</span><span class="ag-v">${esc(a.step || '—')}</span></div>` : ''}
      <div class="ag-meta"><span>Started <b>${esc(clock(a.started))}</b></span>
        <span>${running ? 'Elapsed' : 'Took'} <b class="ag-el" data-run="${running ? 1 : 0}" data-base="${el ?? ''}">${dur(el)}</b></span>
        <span class="ag-id">${esc(a.kind)} · ${esc(a.id)}</span></div>
      ${!running && a.result ? `<div class="ag-result"><span class="ag-k">Result</span><div class="ag-rtext${open ? ' open' : ''}">${esc(a.result)}</div></div>` : ''}
      ${long || (a.result && a.result.length > 260) ? `<button class="ag-more" data-more="${esc(a.id)}">${open ? 'Show less' : 'Show more'}</button>` : ''}
    </article>`;
  }

  function render(){
    if (!data){ body.innerHTML = `<div class="ag-empty">${esc(lastErr || 'Loading…')}</div>`; return; }
    const list = data.agents;
    sum.textContent = `${data.running} running · ${list.length} total`;
    if (!list.length){ body.innerHTML = '<div class="ag-empty">No sub-agents yet. Hand a long job to Atlas and it shows up here.</div>'; return; }
    const keep = body.scrollTop;
    const run = list.filter(a => a.status === 'running' || a.status === 'stalled');
    const rec = list.filter(a => !(a.status === 'running' || a.status === 'stalled'));
    body.innerHTML = (run.length ? `<div class="ag-sec">Running</div><div class="ag-grid">${run.map(card).join('')}</div>` : '')
      + (rec.length ? `<div class="ag-sec">Recent</div><div class="ag-grid">${rec.map(card).join('')}</div>` : '');
    body.scrollTop = keep;
  }

  // tick elapsed counters every second between polls
  setInterval(() => {
    if (ov.hidden || !data) return;
    const dt = (Date.now() - fetchedAt) / 1000;
    ov.querySelectorAll('.ag-el[data-run="1"]').forEach(e => { e.textContent = dur(parseFloat(e.dataset.base) + dt); });
  }, 1000);

  function setBadge(){
    const n = data ? data.running : 0;
    btn.dataset.count = n ? String(n) : '';
    btn.classList.toggle('busy', n > 0);
  }

  async function poll(){
    try {
      const r = await fetch('/api/agents', {headers: {'x-jarvis-token': TOKEN}, cache: 'no-store'});
      if (!r.ok) throw new Error(r.status === 401 ? 'Session token rejected — reload the page.' : `Server said ${r.status}.`);
      data = await r.json(); fetchedAt = Date.now(); lastErr = '';
      live.classList.remove('err'); live.textContent = 'LIVE · every 2s';
    } catch (e) {
      lastErr = e.message || 'Cannot reach the dashboard server.';
      live.classList.add('err'); live.textContent = 'OFFLINE · retrying';
    }
    setBadge();
    if (!ov.hidden) render();
  }
  async function stopJob(id){
    if (!armed.has(id)){                              // first click arms; it disarms itself after 4s
      armed.add(id); render();
      setTimeout(() => { if (armed.delete(id)) render(); }, 4000);
      return;
    }
    armed.delete(id); stopping.add(id); render();
    try {
      const r = await fetch('/api/agents/stop', {method: 'POST', cache: 'no-store',
        headers: {'x-jarvis-token': TOKEN, 'content-type': 'application/json'}, body: JSON.stringify({id})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok){ live.classList.add('err'); live.textContent = `STOP FAILED · ${j.error || r.status}`; }
    } catch (_) { live.classList.add('err'); live.textContent = 'STOP FAILED · server unreachable'; }
    setTimeout(() => { stopping.delete(id); poll(); }, 1500);
  }

  function schedule(){
    clearTimeout(timer);
    timer = setTimeout(async () => { await poll(); schedule(); }, ov.hidden ? 8000 : 2000);
  }

  function open(){
    ov.hidden = false; btn.setAttribute('aria-expanded', 'true');
    document.getElementById('scrim')?.click();       // drop any open drawer
    render(); poll(); schedule();
    ov.querySelector('#agClose').focus();
  }
  function close(){ ov.hidden = true; btn.setAttribute('aria-expanded', 'false'); schedule(); }

  btn.addEventListener('click', () => ov.hidden ? (window.AtlasNav ? AtlasNav.go('agents') : open()) : close());
  ov.querySelector('#agClose').addEventListener('click', close);
  ov.addEventListener('click', e => {
    if (e.target === ov) return close();
    const m = e.target.closest('[data-more]');
    if (m){ const id = m.dataset.more; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
    const s = e.target.closest('[data-stop]');
    if (s && !s.disabled) stopJob(s.dataset.stop);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden){ e.stopPropagation(); close(); } }, true);
  if (window.AtlasNav) AtlasNav.views.agents = {open, close, isOpen: () => !ov.hidden};
  window.AtlasAgents = {open, close};

  poll().then(schedule);
  if (/agentsview=/.test(location.hash)) open();
})();
