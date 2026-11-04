// ══════════ IIFE · Cmd+K command palette + ? shortcut sheet ══════════
(() => {
  'use strict';
  const CMDS = [
    ['/new', 'New thread', 'Fresh conversation', () => transmit('/new', {speak:false}), '/new'],
    ['/goal', 'Set standing objective', 'Arm /goal for your next message', () => arm('/goal'), '/goal'],
    ['/browser', 'Browser mission', 'Arm /browser for your next message', () => arm('/browser'), '/browser'],
    ['/background', 'Background mission', 'Arm /background for your next message', () => arm('/background'), '/background'],
    ['/mission', 'Mission queue', 'Read or add to the queue', () => transmit('/mission', {speak:false}), '/mission'],
    ['/personality', 'Tone overlay', 'Arm /personality', () => arm('/personality'), '/personality'],
    ['/status', 'Gateway status', 'Show runtime + profile', () => transmit('/status', {speak:false}), '/status'],
    ['/tools', 'Hermes tools', 'Show connected tools', () => transmit('/tools', {speak:false}), '/tools'],
    ['/toolsets', 'Hermes toolsets', 'List toolsets', () => transmit('/toolsets', {speak:false}), '/toolsets'],
    ['/connectors', 'Connectors', 'How apps connect', () => transmit('/connectors', {speak:false}), '/connectors'],
    ['/commands', 'All commands', 'List dashboard commands', () => transmit('/commands', {speak:false}), '/commands'],
  ];
  const NAV = [
    ['Inbox', 'Drop files, CSVs & quick notes', () => AtlasNav ? AtlasNav.go('inbox') : $('#navInbox')?.click(), '⌘', 'I'],
    ['Departments', 'Browse departments & teams', () => AtlasNav ? AtlasNav.go('departments') : $('#navDepts')?.click(), '⌘', 'D'],
    ['Brain', 'Second-brain graph', () => AtlasNav ? AtlasNav.go('brain') : $('#navBrain')?.click(), '⌘', 'B'],
    ['Jobs & Activity', 'Running & completed handoff missions + POD/inbox', () => AtlasNav ? AtlasNav.go('jobs') : $('#navJobs')?.click(), '⌘', 'J'],
    ['Agents', 'Live sub-agents', () => AtlasNav ? AtlasNav.go('agents') : $('#navAgents')?.click(), '⌘', 'A'],
    ['Action Logs', 'Telemetry stream', () => $('#navLogs')?.click(), '⌘', ''],
    ['Command Matrix', 'Browse all commands', () => $('#navCmds')?.click(), '⌘', ''],
    ['Settings', 'Theme, voice, profile', () => $('#settingsBtn')?.click(), '⌘', 'S'],
    ['Morning brief', 'Back to the day-at-a-glance', () => window.AtlasBrief && AtlasBrief.focus(), '⌘', 'H'],
    ['Ambient display', 'Wall / desk display mode', () => window.AtlasAmbient && AtlasAmbient.on(), '⌘', 'W'],
  ];
  const THEME_ACTIONS = (() => {
    const list = [];
    const names = [['atlas','Atlas'],['terminal','Terminal'],['folio','Folio'],['brutal','Brutal'],['aurora','Aurora'],['blueprint','Blueprint'],['clay','Clay']];
    for (const [id, name] of names){
      list.push([`Theme: ${name}`, 'Switch theme', () => document.querySelector(`#themeGrid [data-theme-id="${id}"]`)?.click(), id, 'T']);
    }
    list.push(['Light / dark', 'Toggle mode', () => $('#modeBtn')?.click(), '☾', 'M']);
    return list;
  })();

  function arm(cmd){
    disarm();
    const el = document.querySelector(`.cmd[data-cmd="${cmd}"]`);
    if (el) el.classList.add('armed');
    const input = $('#input');
    input.dataset.cmd = cmd; input.focus();
  }

  const ov = document.createElement('div');
  ov.className = 'palette-overlay'; ov.hidden = true;
  ov.innerHTML = `<div class="palette" role="dialog" aria-label="Command palette">
    <div class="pal-input-wrap"><span class="pal-ico">⌘</span><input id="palInput" type="text" placeholder="Search commands, departments, notes, themes…" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div>
    <div class="pal-results" id="palResults"></div></div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('#palInput'), results = ov.querySelector('#palResults');

  let items = [], sel = 0, brainNotes = [], agentsNow = [];
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));

  async function loadBrain(){
    try {
      const g = await fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json());
      brainNotes = (g.nodes || []).filter(n => n.type !== 'other').map(n => ({id: n.id, type: n.type, group: n.group || ''}));
    } catch (_) { brainNotes = []; }
  }
  async function loadAgents(){
    try {
      const a = await fetch('/api/agents', {headers: apiHeaders()}).then(r => r.json());
      agentsNow = (a.agents || []).filter(x => x.status === 'running' || x.status === 'stalled').map(x => ({name: x.name, step: x.step || ''}));
    } catch (_) { agentsNow = []; }
  }

  function buildItems(query){
    const q = (query || '').toLowerCase().trim();
    const out = [];
    const push = (group, name, sub, hint, icon, run) => out.push({group, name, sub, hint, icon, run});
    for (const [cmd, name, sub, run, hint] of CMDS) push('Commands', cmd, sub, '', '/', run);
    for (const [name, sub, run, , hint] of NAV) push('Navigate', name, sub, hint, '▸', run);
    for (const d of (window.AtlasData ? AtlasData.depts : [])){
      push('Departments', d.name, d.remit || '', 'D', '§', () => AtlasNav.go('departments', {dept: d.slug}));
      for (const t of d.teams) push('Teams', `${t.name} — ${d.name}`, t.remit || '', '', '§', () => AtlasNav.go('departments', {dept: d.slug, team: t.slug}));
    }
    for (const n of brainNotes) push('Brain notes', n.id, n.type + (n.group ? ' · ' + n.group : ''), '', '◈', () => AtlasNav.go('brain', n.id));
    for (const a of agentsNow) push('Agents', a.name, a.step || 'working', '', '◉', () => AtlasNav.go('agents'));
    for (const [name, sub, run, hint] of THEME_ACTIONS) push('Themes', name, sub, hint, '◐', run);

    if (!q) return out;
    const scored = [];
    for (const it of out){
      const n = it.name.toLowerCase();
      if (n === q) scored.push([0, it]);
      else if (n.startsWith(q)) scored.push([1, it]);
      else if (n.includes(q)) scored.push([2 + n.indexOf(q) * 0.01, it]);
      else if ((it.sub || '').toLowerCase().includes(q)) scored.push([5, it]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, 40).map(s => s[1]);
  }

  function render(){
    sel = Math.min(sel, Math.max(0, items.length - 1));
    if (!items.length){
      const q = input.value.trim();
      results.innerHTML = q
        ? `<div class="pal-empty">No match. Press Enter to <b>Ask Atlas: ${esc(q)}</b>.</div>`
        : '<div class="pal-empty">Type to search. Arrows to move, Enter to run, Tab to arm a command, Esc to close.</div>';
      return;
    }
    let html = '', lastGroup = '';
    items.forEach((it, i) => {
      if (it.group !== lastGroup){ html += `<div class="pal-group">${esc(it.group)}</div>`; lastGroup = it.group; }
      html += `<button type="button" class="pal-item${i === sel ? ' sel' : ''}" data-i="${i}">
        <span class="pi-ico">${it.icon}</span>
        <span class="pi-name">${esc(it.name)}<span class="pi-sub">${esc(it.sub || '')}</span></span>
        ${it.hint ? `<span class="pi-hint">${esc(it.hint)}</span>` : ''}</button>`;
    });
    results.innerHTML = html;
    results.querySelector('.sel')?.scrollIntoView({block: 'nearest'});
  }

  function runItem(it){
    if (!it) return;
    close();
    try { it.run(); } catch (_) {}
  }

  function askAtlas(){
    const q = input.value.trim();
    close();
    const inp = $('#input'); if (!inp || !q) return;
    inp.value = q; inp.focus();
  }

  function open(){
    ov.hidden = false;
    input.value = ''; items = buildItems(''); sel = 0;
    render();
    if (document.activeElement !== input) input.focus();
    loadBrain(); loadAgents().then(() => { items = buildItems(input.value); render(); });
  }
  function close(){ ov.hidden = true; }

  input.addEventListener('input', () => { items = buildItems(input.value); sel = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown'){ e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); render(); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); sel = (sel - 1 + Math.max(1, items.length)) % Math.max(1, items.length); render(); }
    else if (e.key === 'Enter'){ e.preventDefault(); items.length ? runItem(items[sel]) : askAtlas(); }
    else if (e.key === 'Tab'){ e.preventDefault(); if (items.length) runItem(items[sel]); }
    else if (e.key === 'Escape'){ e.stopPropagation(); close(); }
  });
  results.addEventListener('mousedown', e => {
    const b = e.target.closest('.pal-item'); if (!b) return;
    e.preventDefault(); runItem(items[+b.dataset.i]);
  });
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); ov.hidden ? open() : close(); }
  });
  window.AtlasPalette = {open, close, isOpen: () => !ov.hidden};

  // ── ? shortcut sheet ──
  const help = document.createElement('div');
  help.className = 'help-overlay'; help.hidden = true;
  const K = (s) => `<kbd>${esc(s)}</kbd>`;
  const row = (label, keys) => `<div class="help-row"><span>${label}</span><span class="hr-keys">${keys}</span></div>`;
  help.innerHTML = `<div class="help-sheet" role="dialog" aria-label="Keyboard shortcuts">
    <div class="h">Shortcuts</div><div class="help-sub">Press <kbd>?</kbd> anytime to reopen this. Single-letter keys work only when you are not typing.</div>
    <div class="help-grid">
      <div class="help-sec"><h4>Command &amp; voice</h4>
        ${row('Command palette', K('⌘') + K('K'))}
        ${row('Open / close mic (latch)', K('Space'))}
        ${row('Call mode (silent)', K('Alt') + K('C'))}
        ${row('Focus composer / slash', K('/'))}
        ${row('Cancel a running answer', K('Esc'))}</div>
      <div class="help-sec"><h4>Go to… (press G first)</h4>
        ${row('Home / morning brief', K('G') + K('H'))}
        ${row('Departments', K('G') + K('D'))}
        ${row('Brain', K('G') + K('B'))}
        ${row('Activity / Agents', K('G') + K('A'))}
        ${row('Jobs', K('G') + K('J'))}
        ${row('Inbox', K('G') + K('I'))}
        ${row('Settings', K('G') + K('S'))}
        ${row('Ambient wall display', K('G') + K('W'))}</div>
      <div class="help-sec"><h4>Appearance</h4>
        ${row('Cycle theme', K('T'))}
        ${row('Light / dark', K('M'))}
        ${row('Mute Atlas speech', K('⇧') + K('M'))}</div>
      <div class="help-sec"><h4>Composer</h4>
        ${row('Send', K('Enter'))}
        ${row('New line', K('⇧') + K('Enter'))}
        ${row('Send from anywhere', K('⌘') + K('↵'))}
        ${row('Tab / arrows in slash menu', K('Tab') + K('↑') + K('↓'))}</div>
    </div></div>`;
  document.body.appendChild(help);
  const helpBtn = $('#helpBtn');
  const openHelp = () => { help.hidden = false; };
  const closeHelp = () => { help.hidden = true; };
  if (helpBtn) helpBtn.addEventListener('click', () => help.hidden ? openHelp() : closeHelp());
  help.addEventListener('click', e => { if (e.target === help) closeHelp(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !help.hidden){ closeHelp(); return; }
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)){
      e.preventDefault(); help.hidden ? openHelp() : closeHelp();
    }
  });

  // ── single-letter shortcuts (never while typing) ──
  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const emptyComposer = () => document.activeElement === $('#input') && !$('#input').value;
  let gArmed = false, gTimer = null;
  const cycleTheme = () => {
    const btns = [...document.querySelectorAll('#themeGrid [data-theme-id]')];
    if (!btns.length) return;
    const cur = document.documentElement.dataset.theme;
    const i = btns.findIndex(b => b.dataset.themeId === cur);
    (btns[(i + 1) % btns.length] || btns[0]).click();
  };
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing() && !emptyComposer()) return;
    const k = e.key.toLowerCase();
    if (k === 'g' && !gArmed){
      gArmed = true; clearTimeout(gTimer);
      gTimer = setTimeout(() => { gArmed = false; }, 1200);
      return;
    }
    if (gArmed && k !== 'g'){
      gArmed = false; clearTimeout(gTimer);
      const go = {
        h: () => window.AtlasBrief && AtlasBrief.focus(),
        d: () => AtlasNav ? AtlasNav.go('departments') : $('#navDepts')?.click(),
        b: () => AtlasNav ? AtlasNav.go('brain') : $('#navBrain')?.click(),
        a: () => AtlasNav ? AtlasNav.go('agents') : $('#navAgents')?.click(),
        j: () => AtlasNav ? AtlasNav.go('jobs') : $('#navJobs')?.click(),
        i: () => AtlasNav ? AtlasNav.go('inbox') : $('#navInbox')?.click(),
        s: () => $('#settingsBtn')?.click(),
        w: () => window.AtlasAmbient && AtlasAmbient.toggle(),
      }[k];
      if (go){ e.preventDefault(); go(); }
      return;
    }
    if (k === 't'){ e.preventDefault(); cycleTheme(); }
    else if (k === 'm' && !e.shiftKey){ e.preventDefault(); $('#modeBtn')?.click(); }
    else if (k === 'm' && e.shiftKey){ e.preventDefault(); $('#mute')?.click(); }
  });
})();
