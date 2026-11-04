// ══════════ IIFE · morning brief home screen (real data: jobs, agents, brain, greeting) ══════════
(() => {
  'use strict';
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));
  const data = {greeting: '', date: '', agents: [], running: 0, brainCount: 0, brainDepts: [], collapsed: false,
                pulse: null,           // GET /api/brief: business + calendar, fetched by a quiet Hermes helper
                inbox: []};
  let pulseTimer = null;
  window.AtlasBrief = {data, focus(){ const b = document.getElementById('brief'); if (b) b.scrollIntoView({behavior: 'smooth', block: 'start'}); }, refresh};

  function fmtWhen(ts){
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const today = new Date(); const yest = new Date(); yest.setDate(today.getDate() - 1);
    const sameDay = x => x.toDateString() === d.toDateString();
    if (sameDay(today)) return 'today ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (sameDay(yest)) return 'yesterday ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    return d.toLocaleDateString([], {month: 'short', day: 'numeric'});
  }
  function dur(s){
    if (s == null) return '';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m` : `${s}s`;
  }

  async function refresh(){
    const out = {agents: [], running: 0, brainCount: 0, brainDepts: []};
    try {
      const g = await fetch('/api/greeting', {headers: apiHeaders()}).then(r => r.json());
      if (g && g.text) data.greeting = g.text;
    } catch (_) {}
    try {
      const a = await fetch('/api/agents', {headers: apiHeaders()}).then(r => r.json());
      out.agents = a.agents || [];
      out.running = a.running || 0;
    } catch (_) {}
    try {
      const b = await fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json());
      const nodes = b.nodes || [];
      out.brainCount = nodes.length;
      out.brainDepts = nodes.filter(n => n.type === 'dept').map(n => n.id.replace(/-/g, ' '));
    } catch (_) {}
    try {
      const i = await fetch('/api/inbox', {headers: apiHeaders(), cache: 'no-store'}).then(r => r.json());
      data.inbox = Array.isArray(i.items) ? i.items : [];
    } catch (_) {}
    data.agents = out.agents; data.running = out.running;
    data.brainCount = out.brainCount; data.brainDepts = out.brainDepts;
    await loadPulse();
    data.date = new Date().toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'});
    window.dispatchEvent(new CustomEvent('atlas-brief'));
    render();
  }

  // ── business + calendar: once a day by itself, ↻ for a fresh fetch ──
  async function loadPulse(post){
    try {
      const r = await fetch('/api/brief', post
        ? {method: 'POST', headers: apiHeaders({'content-type': 'application/json'}), body: JSON.stringify(post)}
        : {headers: apiHeaders(), cache: 'no-store'});
      if (r.ok) data.pulse = await r.json();
    } catch (_) {}
    if (!post && data.pulse && data.pulse.auto) return loadPulse({auto: true});
    clearTimeout(pulseTimer);
    if (data.pulse && data.pulse.status === 'running')     // watch the helper until it lands
      pulseTimer = setTimeout(async () => { await loadPulse(); render(); }, 6000);
  }

  function pulseBody(kind){
    const p = data.pulse, rows = (p && p.data && p.data[kind]) || [];
    if (rows.length){
      const html = rows.map(x => kind === 'business'
        ? `<div class="bc-item"><span class="bci-t">${esc(x.label)}</span><span class="bci-m">${esc(x.value)}</span></div>`
        : `<div class="bc-item"><span class="bci-t">${esc(x.what)}</span><span class="bci-m">${esc(x.when)}</span></div>`).join('');
      const when = p.data.fetched ? new Date(p.data.fetched * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
      return html + (p.status === 'running' ? '<span class="bc-empty">refreshing…</span>'
                                             : when ? `<span class="bc-empty">updated ${esc(when)}</span>` : '');
    }
    if (!p) return '<span class="bc-empty">Brief data unavailable.</span>';
    if (p.status === 'running') return '<span class="bc-empty">Asking Hermes for today\'s numbers…</span>';
    if (p.status === 'failed') return `<span class="bc-empty">${esc(p.error || 'Hermes couldn\'t fetch it.')}</span>`;
    const why = ((p.data && p.data.missing) || []).filter(m => kind === 'calendar'
      ? /calendar|event|birthday/i.test(m) : !/calendar|event|birthday/i.test(m));
    if (p.status === 'ready') return `<span class="bc-empty">${esc(why[0] || 'Nothing to report.')}</span>`;
    return kind === 'business'
      ? '<span class="bc-empty">Connect a store in Hermes, then press ↻.</span>'
      : '<span class="bc-empty">Connect a calendar in Hermes, then press ↻.</span>';
  }

  function pulseLines(){
    const d = data.pulse && data.pulse.data;
    if (!d || (!d.business.length && !d.calendar.length))
      return ['Business and calendar are not connected in Hermes yet.'];
    const out = [];
    if (d.business.length) out.push('Business: ' + d.business.slice(0, 4).map(x => `${x.label}, ${x.value}`).join('; ') + '.');
    if (d.calendar.length) out.push('Coming up: ' + d.calendar.slice(0, 4).map(x => `${x.what}, ${x.when}`).join('; ') + '.');
    return out;
  }

  // ── "Needs your decision": everything waiting on you, each with one action ──
  function decisions(){
    const out = [];
    const ap = window.AtlasApprovals && AtlasApprovals.pending();
    if (ap) out.push({t: `Approve: ${ap.description}`, btn: 'Answer', act: 'approval',
                      m: ap.count > 1 ? `${ap.count} waiting` : ap.high ? 'keyboard only' : 'say yes or no'});
    const dayAgo = Date.now() / 1000 - 86400;
    for (const a of data.agents){
      if (a.status === 'stalled'){
        // Delegated children can't be stopped from here (no worker to signal): open the
        // tab instead of offering a Clear that would just fail.
        if (a.stoppable === false) out.push({t: a.name, m: 'agent stopped mid-job', btn: 'Open', act: 'agents'});
        else out.push({t: a.name, m: 'helper stopped mid-job', btn: 'Clear', act: 'clear', id: a.id});
      }
      else if (a.status === 'failed' && !a.quiet && (a.finished || 0) > dayAgo) out.push({t: a.name, m: 'failed: see why', btn: 'Open', act: 'agents'});
    }
    const waiting = data.inbox.filter(i => i.status === 'new' || i.status === 'needs-question');
    if (waiting.length) out.push({t: `${waiting.length} inbox item${waiting.length > 1 ? 's' : ''} to file`,
                                  m: waiting.slice(0, 2).map(i => i.name).join(', '), btn: 'Review', act: 'inbox'});
    if (data.pulse && data.pulse.status === 'failed')
      out.push({t: "Today's numbers didn't load", m: data.pulse.error || '', btn: 'Retry', act: 'pulse'});
    return out;
  }

  function decisionsHtml(items){
    return items.slice(0, 5).map((d, i) => `<div class="bc-item bc-act"><span class="bci-t">${esc(d.t)}</span>
      <span class="bci-m">${esc(d.m)}</span><button type="button" class="bc-go" data-decide="${i}">${esc(d.btn)}</button></div>`).join('');
  }

  async function decide(d){
    if (d.act === 'approval') return window.AtlasApprovals && AtlasApprovals.focus();
    if (d.act === 'agents') return window.AtlasAgents && AtlasAgents.open();
    if (d.act === 'inbox') return window.AtlasInbox && AtlasInbox.open();
    if (d.act === 'pulse') return loadPulse({refresh: true}).then(render);
    if (d.act === 'clear'){
      try {
        await fetch('/api/agents/stop', {method: 'POST', headers: apiHeaders({'content-type': 'application/json'}),
                                         body: JSON.stringify({id: d.id})});
      } catch (_) {}
      return refresh();
    }
  }

  function sentence(){
    const waiting = decisions().length;
    const done = data.agents.filter(a => a.status === 'done' || a.status === 'failed').length;
    const running = data.running;
    const parts = [];
    if (waiting) parts.push(`${waiting} need${waiting > 1 ? '' : 's'} your decision`);
    if (running) parts.push(`${running} mission${running > 1 ? 's' : ''} running`);
    if (done) parts.push(`${done} finished overnight`);
    if (data.brainCount) parts.push(`${data.brainCount} notes in the second brain`);
    if (!parts.length) return 'Nothing outstanding — a clean start.';
    return parts.join(' · ') + '.';
  }

  function card(color, title, count, body, empty){
    return `<div class="b-card" style="--c:var(${color})"><h5><span class="bc-dot"></span>${title}${count != null ? `<span class="bc-n">${count}</span>` : ''}</h5>
      <div class="bc-body">${body || `<span class="bc-empty">${empty || ''}</span>`}</div></div>`;
  }

  function render(){
    const host = document.getElementById('brief');
    if (!host) return;
    if (data.collapsed){
      host.innerHTML = `<div class="brief"><div class="b-head"><span class="b-sentence">${esc(data.greeting || 'Good day.')} <b style="color:var(--cyan)">${esc(sentence())}</b></span></div>
        <div class="b-actions"><button class="ctl aux" data-brief="expand">Show full brief ▴</button></div></div>`;
      return;
    }
    const items = decisions();
    const running = data.agents.filter(a => a.status === 'running' || a.status === 'stalled');
    const recent = data.agents.filter(a => !(a.status === 'running' || a.status === 'stalled')).slice(0, 3);
    const runningHtml = running.length
      ? running.slice(0, 3).map(a => `<div class="bc-item"><span class="bci-t">${esc(a.name)}</span><span class="bci-m">${esc(a.step || 'working…')}</span></div>`).join('')
      : '<span class="bc-empty">No agents running.</span>';
    const overnightHtml = recent.length
      ? recent.map(a => `<div class="bc-item"><span class="bci-t">${esc(a.name)}</span><span class="bci-m">${esc(a.status)}${a.started ? ' · ' + fmtWhen(a.started) : ''}${a.elapsed ? ' · ' + dur(a.elapsed) : ''}</span></div>`).join('')
      : '<span class="bc-empty">Nothing finished overnight.</span>';
    const brainHtml = data.brainCount
      ? `${data.brainCount} notes. ${data.brainDepts.length ? data.brainDepts.slice(0, 5).map(d => `<span class="bc-pill"><span class="bci-s">§</span>${esc(d)}</span>`).join('') : ''}`
      : '<span class="bc-empty">No brain folder found yet.</span>';
    host.innerHTML = `<div class="brief">
      <div class="b-head"><div><div class="b-date">${esc(data.date)}</div><div class="b-sentence" style="margin-top:4px">${esc(data.greeting || 'Good day.')}</div></div>
        <div class="b-actions"><button class="ctl aux" data-brief="play">▶ Play my brief</button><button class="ctl aux" data-brief="collapse">Collapse ▴</button></div></div>
      <div class="b-sentence">${esc(sentence())}</div>
      <div class="b-grid">
        ${card('--amber', 'Needs your decision', items.length, decisionsHtml(items), 'Nothing needs you right now.')}
        ${card('--cyan', 'Running', data.running, runningHtml)}
        ${card('--green', 'Overnight', recent.length, overnightHtml)}
        ${card('--dept-3', 'Second brain', data.brainCount, brainHtml)}
        ${card('--dept-4', 'Business pulse' + refreshBtn(), null, pulseBody('business'))}
        ${card('--dept-5', 'Family & calendar' + refreshBtn(), null, pulseBody('calendar'))}
      </div></div>`;
    host.querySelectorAll('[data-brief]').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.brief;
      if (act === 'collapse'){ data.collapsed = true; render(); }
      else if (act === 'expand'){ data.collapsed = false; render(); }
      else if (act === 'play') playBrief();
      else if (act === 'pulse' && !(data.pulse && data.pulse.status === 'running'))
        loadPulse({refresh: true}).then(render);
    }));
    host.querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', () => {
      b.disabled = true;
      decide(items[+b.dataset.decide]);
    }));
  }

  function refreshBtn(){
    const busy = data.pulse && data.pulse.status === 'running';
    return `<button type="button" class="bc-refresh" data-brief="pulse" title="${busy ? 'Fetching…' : 'Ask Hermes for fresh numbers'}"
      aria-label="Refresh business and calendar" ${busy ? 'disabled' : ''}>↻</button>`;
  }

  function playBrief(){
    if (muted) return;
    const lines = [
      data.greeting || 'Good day.',
      sentence(),
      data.running ? `${data.running} missions are running now.` : 'No missions are running.',
      data.agents.filter(a => a.status === 'done' || a.status === 'failed').length
        ? `${data.agents.filter(a => a.status === 'done' || a.status === 'failed').length} missions finished overnight.`
        : 'Nothing finished overnight.',
      data.brainCount ? `Your second brain holds ${data.brainCount} notes.` : 'Your second brain is empty.',
      ...pulseLines(),
      ...decisions().slice(0, 3).map(d => `Needs your decision: ${d.t}.`)
    ];
    say(lines.join(' '));
  }

  const resp = document.getElementById('response');
  const obs = new MutationObserver(() => {
    const welcome = resp.querySelector('.welcome');
    if (!welcome || document.getElementById('brief')) return;
    const brief = document.createElement('div');
    brief.id = 'brief';
    welcome.insertBefore(brief, welcome.firstChild);
    refresh();
  });
  obs.observe(resp, {childList: true, subtree: true});
  if (resp.querySelector('.welcome')) {
    const brief = document.createElement('div'); brief.id = 'brief';
    resp.querySelector('.welcome').insertBefore(brief, resp.querySelector('.welcome').firstChild);
    refresh();
  }
  document.addEventListener('atlas-brief', () => { if (window.AtlasAmbient) AtlasAmbient.onBriefData(data); });
  window.addEventListener('atlas-approval', () => render());   // an approval appeared or was answered
})();
