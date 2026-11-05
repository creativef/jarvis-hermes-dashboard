// ══════════ greeting on launch ══════════
(() => {
  const GKEY = 'jarvis.greeted';
  let text = '', armed = null;

  async function boot(){
    let g;
    try { g = await fetch('/api/greeting', {headers: apiHeaders()}).then(r => r.json()); } catch(_){ return; }
    if (!g || !g.text) return;
    text = g.text; window.__greetText = text;
    const h = document.querySelector('.welcome h3'); if (h) h.textContent = text;   // visible even if never spoken
    if (!g.enabled) return;

    // once per calendar day — a server restart must never re-trigger it
    const mark = new Date().toDateString();
    if (localStorage.getItem(GKEY) === mark) return;

    const speakIt = () => {
      if (!armed) return Promise.resolve();
      armed = null; window.__greetNow = null;
      localStorage.setItem(GKEY, mark);
      log('voice', 'GREETING', text);
      return say(text);                         // honours mute / call mode (speak() no-ops when muted)
    };
    armed = speakIt;
    // Browsers block audio until the page has been touched, and speaking on load lands on top of
    // a live reply — so the greeting always waits for a real gesture.
    window.__greetNow = speakIt;
    const first = e => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt')) return;
      document.removeEventListener('keydown', first, true);
      document.removeEventListener('pointerdown', first, true);
      if (e.type === 'keydown' && e.code === 'Space') return;   // Space → the mic gate awaits __greetNow itself
      if (armed) armed();
    };
    document.addEventListener('keydown', first, true);
    document.addEventListener('pointerdown', first, true);
  }

  // settings fields
  $('#settingsBtn').addEventListener('click', async () => {
    try {
      const s = await fetch('/api/settings', {headers: apiHeaders()}).then(r => r.json());
      $('#set-name').value = s.user_name || '';
      $('#set-greet').checked = s.greeting !== false;
    } catch(_){}
  });
  $('#settingsSave').addEventListener('click', async () => {
    try {
      await fetch('/api/settings', {method:'POST', headers: apiHeaders({'content-type':'application/json'}),
        body: JSON.stringify({user_name: $('#set-name').value, greeting: $('#set-greet').checked})});
      localStorage.removeItem(GKEY);
    } catch(_){ log('error', 'SETTINGS', 'could not save greeting settings'); }
  });

  setTimeout(boot, 600);   // after the main boot has drawn the welcome state
})();
