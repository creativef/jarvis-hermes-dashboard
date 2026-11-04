// ══════════ settings: voice, speed, barge-in ══════════
(() => {
  const label = v => {
    const [kind, name] = String(v).split('_');
    return `${(name || v)[0].toUpperCase()}${(name || v).slice(1)} · ${kind?.[0] === 'b' ? 'British' : 'American'}`;
  };
  $('#settingsBtn').addEventListener('click', async () => {
    $('#set-barge').checked = bargeOn;
    try {
      const s = await fetch('/api/settings', {headers: apiHeaders()}).then(r => r.json());
      const voices = s.voices || [];
      if (s.voice && !voices.includes(s.voice)) voices.unshift(s.voice);
      $('#set-voice').innerHTML = voices.map(v => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
      $('#set-voice').value = s.voice || '';
      $('#set-speed').value = s.voice_speed ?? 1;
    } catch(_){}
  });
  $('#settingsSave').addEventListener('click', async () => {
    bargeOn = $('#set-barge').checked;
    try { localStorage.setItem('jarvis.barge', bargeOn ? '1' : '0'); } catch(_){}
    const body = {voice_speed: parseFloat($('#set-speed').value)};
    if ($('#set-voice').value) body.voice = $('#set-voice').value;
    try {
      const r = await fetch('/api/settings', {method:'POST', headers: apiHeaders({'content-type':'application/json'}),
        body: JSON.stringify(body)}).then(r => r.json());
      if (r.error) log('error', 'SETTINGS', r.error);
      else log('note', 'SETTINGS', `voice ${r.voice} at ${r.voice_speed}× · barge-in ${bargeOn ? 'on' : 'off'}`);
    } catch(_){ log('error', 'SETTINGS', 'could not save voice settings'); }
  });
})();
