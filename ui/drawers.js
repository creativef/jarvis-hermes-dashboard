// ══════════ top-menu drawers (Command Matrix / Action Logs) ══════════
(() => {
  const drawers = { navCmds: '#drawerCmds', navLogs: '#drawerLogs' };
  const scrim = $('#scrim');
  function closeAll(){
    Object.entries(drawers).forEach(([b, d]) => { $(d).hidden = true; $('#' + b).setAttribute('aria-expanded', 'false'); });
    scrim.hidden = true;
  }
  function toggle(btnId){
    const open = !$(drawers[btnId]).hidden;
    closeAll();
    if (open) return;
    $(drawers[btnId]).hidden = false;
    $('#' + btnId).setAttribute('aria-expanded', 'true');
    scrim.hidden = false;
  }
  Object.keys(drawers).forEach(b => $('#' + b).addEventListener('click', () => toggle(b)));
  scrim.addEventListener('click', closeAll);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeAll));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !scrim.hidden) closeAll(); });
  // arming a command, or running a quick action, drops you back at the chat
  $('#cmds').addEventListener('click', e => { if (e.target.closest('.cmd')) closeAll(); });
  $('#showCommands').addEventListener('click', closeAll);
  $('#missionBtn').addEventListener('click', closeAll);
})();
