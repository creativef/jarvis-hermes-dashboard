// ══════════ IIFE · ambient wall-display mode on the focus layout ══════════
(() => {
  'use strict';
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));
  const ov = document.createElement('div');
  ov.className = 'ambient-overlay'; ov.id = 'ambientOverlay'; ov.hidden = true;
  ov.innerHTML = `<div class="am-orb" id="amOrb"><div id="amReactor"></div></div>
    <div class="am-bottom">
      <div class="am-clock" id="amClock">00:00</div>
      <div class="am-date" id="amDate"></div>
      <div class="am-brief" id="amBrief">Atlas is standing by.</div>
      <div class="am-glances">
        <span class="am-glance" id="amGlanceJobs"><i></i><span id="amJobsTxt">0 running</span></span>
        <span class="am-glance" id="amGlanceOk"><i></i><span id="amOkTxt">nothing needs you</span></span>
        <span class="am-glance"><i></i><span id="amLatTxt">latency —</span></span>
      </div>
      <div class="am-hint">press Space to talk · <kbd>G</kbd> <kbd>W</kbd> or Esc to exit</div>
    </div>
    <button id="amExit" class="iconbtn am-exit" title="Exit ambient display">✕</button>`;
  document.body.appendChild(ov);

  let active = false, briefLines = [], briefIdx = 0, briefTimer = null, clockTimer = null;
  let nightTimer = null;

  function setNight(){
    const h = new Date().getHours();
    ov.classList.toggle('night', h >= 22 || h < 7);
  }

  function moveOrb(){
    const reactor = document.getElementById('reactor');
    const host = ov.querySelector('#amReactor');
    if (reactor && host && reactor.parentElement !== host){
      host.appendChild(reactor);
    }
  }
  function restoreOrb(){
    const reactor = document.getElementById('reactor');
    const pane = document.querySelector('.reactorpane');
    if (reactor && pane && reactor.parentElement !== pane){
      pane.insertBefore(reactor, pane.querySelector('.micbar') || null);
    }
  }

  function on(){
    if (active) return;
    active = true;
    document.documentElement.dataset.ambient = '1';
    document.documentElement.dataset.layout = 'focus';
    try { localStorage.setItem('jarvis.layout', 'focus'); } catch (_) {}
    ov.hidden = false;
    moveOrb();
    document.getElementById('ambientBtn')?.setAttribute('aria-pressed', 'true');
    document.getElementById('scrim')?.click();
    document.querySelector('.stage')?.style.setProperty('--orb-scale', '3.4');
    tickClock(); clockTimer = setInterval(tickClock, 1000);
    setNight(); nightTimer = setInterval(setNight, 60000);
    refreshBrief(); briefTimer = setInterval(() => { briefIdx = (briefIdx + 1) % Math.max(1, briefLines.length); showBrief(); }, 9000);
    poll();
  }
  function off(){
    if (!active) return;
    active = false;
    delete document.documentElement.dataset.ambient;
    ov.hidden = true;
    restoreOrb();
    document.getElementById('ambientBtn')?.setAttribute('aria-pressed', 'false');
    document.querySelector('.stage')?.style.removeProperty('--orb-scale');
    clearInterval(clockTimer); clearInterval(briefTimer); clearInterval(nightTimer);
  }
  function toggle(){ active ? off() : on(); }

  function tickClock(){
    const d = new Date();
    document.getElementById('amClock').textContent = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    document.getElementById('amDate').textContent = d.toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'});
  }

  function showBrief(){
    const el = document.getElementById('amBrief');
    if (!el) return;
    const line = briefLines.length ? briefLines[briefIdx % briefLines.length] : null;
    if (line) el.innerHTML = line;
  }

  function refreshBrief(){
    const B = window.AtlasBrief && AtlasBrief.data;
    briefLines = [];
    if (B){
      if (B.greeting) briefLines.push(esc(B.greeting));
      const running = B.running || 0;
      const done = (B.agents || []).filter(a => a.status === 'done' || a.status === 'failed').length;
      briefLines.push(running ? `<b>${running}</b> mission${running > 1 ? 's' : ''} running` : 'No missions running');
      if (done) briefLines.push(`<b>${done}</b> finished overnight`);
      if (B.brainCount) briefLines.push(`Second brain: <b>${B.brainCount}</b> notes`);
    }
    briefLines.push('Business and calendar are not connected yet — connect them to see live data here.');
    briefIdx = 0; showBrief();
  }

  async function poll(){
    try {
      const a = await fetch('/api/agents', {headers: apiHeaders()}).then(r => r.json());
      const n = a.running || 0;
      document.getElementById('amGlanceJobs').classList.toggle('on', n > 0);
      document.getElementById('amJobsTxt').textContent = `${n} running`;
      if (n) refreshBrief();
    } catch (_) {}
  }
  window.AtlasAmbient = {
    on, off, toggle, isOn: () => active,
    onBriefData(d){ if (active && d) refreshBrief(); }
  };

  document.getElementById('amExit').addEventListener('click', off);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && active){ e.preventDefault(); off(); } });
  document.getElementById('ambientBtn')?.addEventListener('click', toggle);

  let idleMin = 0;
  try { idleMin = parseInt(localStorage.getItem('jarvis.ambientIdle') ?? '0', 10) || 0; } catch (_) {}
  if (idleMin > 0){
    let lastAct = Date.now();
    ['pointerdown', 'keydown', 'pointermove'].forEach(t => document.addEventListener(t, () => { lastAct = Date.now(); }, {passive: true}));
    setInterval(() => { if (!active && !document.hidden && Date.now() - lastAct > idleMin * 60000) on(); }, 30000);
  }

  if (/mode=ambient|ambient=1/.test(location.hash)) setTimeout(on, 200);
})();
