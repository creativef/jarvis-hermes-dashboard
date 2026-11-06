// ══════════ greeting on launch ══════════
// Shown on screen at load; spoken at most once a day, as the opening line of the day.
// Whether to speak is asked of the server at the moment of the first gesture, so every
// tab, address (localhost / 127.0.0.1) and restart shares one answer, and it is "no" once
// you have talked today or while anything is running.
(() => {
  let armed = null;

  async function boot(){
    let g;
    try { g = await fetch('/api/greeting', {headers: apiHeaders()}).then(r => r.json()); } catch(_){ return; }
    if (!g || !g.text) return;
    window.__greetText = g.text;
    const h = document.querySelector('.welcome h3'); if (h) h.textContent = g.text;   // visible even if never spoken
    if (!g.enabled) return;

    const speakIt = async (busy) => {
      if (!armed) return;
      armed = null; window.__greetNow = null;
      busy = busy || !!(window.atlasBusy && window.atlasBusy());     // a reply, speech or approval is live
      let r;
      try {
        r = await fetch('/api/greeting?claim=1' + (busy ? '&busy=1' : ''), {headers: apiHeaders()}).then(r => r.json());
      } catch(_){ return; }
      if (!r || !r.speak || !r.text) return;
      log('voice', 'GREETING', r.text);
      return say(r.text);                       // fresh text: never "Good morning" at six in the evening
    };
    armed = speakIt;
    // Browsers block audio until the page has been touched, and speaking on load lands on top of
    // a live reply — so the greeting always waits for a real gesture.
    window.__greetNow = () => speakIt(false);
    const first = e => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt')) return;
      document.removeEventListener('keydown', first, true);
      document.removeEventListener('pointerdown', first, true);
      if (e.type === 'keydown' && e.code === 'Space') return;   // Space → the mic gate awaits __greetNow itself
      // typing into a field means the day's work has started: use up the day's greeting silently
      const t = e.target, typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
      if (armed) armed(typing);
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
    } catch(_){ log('error', 'SETTINGS', 'could not save greeting settings'); }
  });

  setTimeout(boot, 600);   // after the main boot has drawn the welcome state
})();
