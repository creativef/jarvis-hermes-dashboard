// ══════════ v2 enhancements (additive; transmit/voice logic untouched) ══════════
(() => {
  const input = $('#input'), menu = $('#slashMenu');

  // composer: Enter sends, Shift+Enter newline, auto-grow
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
  input.addEventListener('input', grow);
  setInterval(() => { if (!input.value && input.style.height !== '') grow(); }, 800);

  // slash-command autocomplete
  const CMDS = [['/new','Fresh thread'],['/goal','Standing objective'],['/tools','Hermes tool status'],['/browser','Chrome / browser op'],
    ['/background','Async mission'],['/mission','Mission queue'],['/personality','Voice / tone overlay'],['/commands','Show commands'],
    ['/status','Gateway status'],['/toolsets','Toolsets'],['/connectors','Connectors']];
  let sel = 0, items = [];
  const closeMenu = () => { menu.hidden = true; items = []; };
  function renderMenu(){
    const v = input.value;
    if (!/^\/\S*$/.test(v)) return closeMenu();
    items = CMDS.filter(c => c[0].startsWith(v.toLowerCase()));
    if (!items.length || (items.length === 1 && items[0][0] === v)) return closeMenu();
    sel = Math.min(sel, items.length - 1);
    menu.innerHTML = items.map((c,i) => `<div class="slashitem${i===sel?' sel':''}" data-i="${i}" role="option"><b>${c[0]}</b><span>${c[1]}</span></div>`).join('');
    menu.hidden = false;
  }
  function pick(i){ input.value = items[i][0] + ' '; closeMenu(); input.focus(); grow(); }
  input.addEventListener('input', () => { sel = 0; renderMenu(); });
  menu.addEventListener('mousedown', e => { const it = e.target.closest('.slashitem'); if (it){ e.preventDefault(); pick(+it.dataset.i); } });
  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (!menu.hidden){
      if (e.key === 'ArrowDown'){ e.preventDefault(); sel = (sel+1) % items.length; return renderMenu(); }
      if (e.key === 'ArrowUp'){ e.preventDefault(); sel = (sel-1+items.length) % items.length; return renderMenu(); }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)){ e.preventDefault(); return pick(sel); }
      if (e.key === 'Escape'){ e.stopPropagation(); return closeMenu(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey){ e.preventDefault(); sendFromInput(); setTimeout(grow, 0); }
  });
  input.addEventListener('blur', () => setTimeout(closeMenu, 120));

  // armed-command chip (the drawer closes after arming, so show it by the input)
  const chip = $('#armedChip');
  function syncChip(){ const c = input.dataset.cmd || ''; chip.hidden = !c; $('#armedName').textContent = c; }
  new MutationObserver(syncChip).observe(input, {attributes:true, attributeFilter:['data-cmd']});
  $('#armedX').addEventListener('click', () => { disarm(); $('#tip').textContent = defaultTip; input.focus(); });
  syncChip();

  // welcome state with starter prompts (replaces the bare placeholder)
  const STARTERS = [['What can you do?','Capabilities overview'],['/status','Gateway & runtime'],['/tools','Connected Hermes tools'],
    ['Summarise what you did in our last session','Recall'],];
  const resp = $('#response');
  const obs = new MutationObserver(() => {
    const ph = resp.querySelector('.rplaceholder');
    if (!ph) return;
    obs.disconnect();
    resp.innerHTML = `<div class="welcome"><h3>${esc(window.__greetText || 'Good to see you.')}</h3><p>Talk to me with the mic, or type below. Slash commands work, and <kbd>⌘K</kbd> opens the Command Matrix.</p>`
      + `<div class="starters">${STARTERS.map(s => `<button class="starter" data-s="${esc(s[0])}">${esc(s[0])}<small>${esc(s[1])}</small></button>`).join('')}</div></div>`;
    obs.observe(resp, {childList:true});
  });
  obs.observe(resp, {childList:true});
  resp.addEventListener('click', e => {
    const b = e.target.closest('.starter'); if (!b) return;
    input.value = b.dataset.s; $('#run').click();
  });
  // handle the case where the placeholder is already there (before observer attached)
  if (resp.querySelector('.rplaceholder')) resp.appendChild(document.createComment('init'));

  // keyboard shortcuts
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); $('#navCmds').click(); return; }
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey){ e.preventDefault(); input.focus(); input.value = '/'; renderMenu(); }
  });
  $('#navLogs').title = 'Action Logs';
  input.focus();
})();
