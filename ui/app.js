/* JARVIS Live HUD — drives Hermes Agent, streams telemetry.

   The brain is your own `hermes` CLI/profile, so configured Hermes tools,
   browser automation, skills, memory, MCP servers and third-party connectors are live. */
const $ = s => document.querySelector(s);
const RT = {tts:false, stt:false, browserStt:false, browserTts:false};
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynth = window.speechSynthesis;
const API_TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content || '';
const apiHeaders = extra => ({'x-jarvis-token': API_TOKEN, ...(extra || {})});

// ── reactor ticks ──
(() => {
  const g = $('#ticks480');
  for (let i = 0; i < 128; i++){
    const a = (i/128) * Math.PI*2, maj = i % 8 === 0;
    const r0 = maj ? 246 : 250, r1 = 260;
    const l = document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1', 260+Math.cos(a)*r0); l.setAttribute('y1', 260+Math.sin(a)*r0);
    l.setAttribute('x2', 260+Math.cos(a)*r1); l.setAttribute('y2', 260+Math.sin(a)*r1);
    if (maj) l.setAttribute('class','maj');
    g.appendChild(l);
  }
})();

const now = () => new Date().toLocaleTimeString('en-GB', {hour12:false});
const rid = () => 'run_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'').slice(0,24)
                                              : Math.random().toString(16).slice(2,14));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── reactor state ──
function setState(cls, word, sub){
  document.body.className = cls;
  if (word) $('#stword').textContent = word;
  if (sub != null) $('#strun').textContent = sub;
}
function setTag(cls, text){ const t=$('#rtag'); t.className='rtag '+cls; t.textContent=text; }

// ── action log ──
function log(kind, label, msg, jsonHtml){
  const e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = `<div class="top"><span class="ts">${now()}</span>`
    + `<span class="kind">${esc(label)}</span></div>`
    + (msg ? `<div class="msg">${esc(msg)}</div>` : '')
    + (jsonHtml ? `<div class="jsonblk">${jsonHtml}</div>` : '');
  const box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}
function usageBlock(u){
  const row = (k,v) => `  <span class="k">"${k}"</span>: <span class="v">${v}</span>`;
  return `{\n  <span class="k">"usage"</span>: {\n`
    + [row('input_tokens', u.input_tokens), row('output_tokens', u.output_tokens),
       row('total_tokens', u.total_tokens), row('cache_read', u.cache_read),
       row('cache_write', u.cache_write)].join(',\n')
    + `\n  }\n}`;
}

// ── the run ──
let running = false, answer = '', firstDelta = false, speakThisRun = true;
let speakDone = Promise.resolve(), activeController = null;
let history = [], currentUser = '';

async function transmit(message, options = {}){
  if (!message.trim()) return;
  if (running){
    // don't silently swallow it — say so, so it never looks like nothing happened
    log('note','BUSY',`still working — "${message.slice(0,40)}" not sent. Wait, or press Esc to cancel.`);
    return;
  }
  running = true; answer = ''; firstDelta = false; speakThisRun = options.speak !== false;
  currentUser = message;

  const fresh = /^\/new\b/.test(message.trim());
  const id = rid();
  setState('running', 'RUNNING', id.slice(0,20) + '…');
  setTag('run', 'RUNNING');
  renderConversation();
  log('run', 'RUN', `started ${id}; uplink cleared`);

  // visible elapsed counter — a slow answer should never look like a dead screen
  const t0 = performance.now();
  const tick = setInterval(() => {
    if (!running) return;
    const s = ((performance.now()-t0)/1000).toFixed(1);
    if (!answer) $('#strun').textContent = `thinking… ${s}s`;
  }, 200);

  try {
    activeController = new AbortController();
    const res = await fetch('/api/run', {
      method:'POST', headers:apiHeaders({'content-type':'application/json'}),
      body: JSON.stringify({message, fresh}), signal:activeController.signal
    });
    if (!res.ok) throw new Error(`backend returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true){
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream:true});
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); }
        catch(_){ log('error','STREAM','dropped a malformed event frame'); }
      }
    }
  } catch (e){
    if (e?.name === 'AbortError'){
      log('note', 'CANCEL', 'run cancelled');
      setState('', 'STANDBY', 'cancelled');
      setTag('', 'IDLE');
    } else {
      log('error', 'ERROR', String(e).slice(0,200));
      setState('error', 'FAULT', 'stream dropped');
      setTag('err', 'ERROR');
    }
  }
  activeController = null;
  running = false;
  clearInterval(tick);
  await speakDone;                 // don't return until Jarvis has finished talking
}

function handle(ev){
  switch (ev.t){
    case 'status':
      log('status', 'STATUS',
        `core online · Hermes tools=${ev.tools ?? 0} profile=${ev.profile||'default'} permission=${ev.permission||'normal'}`);
      break;
    case 'latency':
      log('latency', 'LATENCY', `first token after ${ev.ms}ms`);
      break;
    case 'tool':
      if (ev.phase === 'use')
        log('tool', 'TOOL', `→ ${ev.name}(${ev.input || ''})`);
      else
        log('tool', 'TOOL', `✓ ${ev.ok===false?'error':'ok'}`);
      break;
    case 'delta':
      answer += ev.text;
      renderConversation();
      if (!firstDelta){
        firstDelta = true;
        log('reason', 'REASONING', answer.slice(0, 220));
      }
      break;
    case 'usage':
      log('status', 'USAGE', 'token usage', usageBlock(ev));
      break;
    case 'complete':
      setState('done', 'COMPLETE', (ev.ms!=null?`${ev.ms}ms`:'') );
      setTag('done', 'COMPLETE');
      log('complete', 'COMPLETE', ev.ms!=null?`run completed in ${ev.ms}ms`:'run completed');
      const spoken = answer;
      if (spoken.trim()) history.push({user: currentUser, assistant: spoken});
      answer = ''; currentUser = '';
      renderConversation(true);
      speakDone = speakThisRun ? speak(spoken) : Promise.resolve();
      break;
    case 'error':
      setState('error', 'FAULT', ev.message?.slice(0,40) || 'error');
      setTag('err', 'ERROR');
      log('error', 'ERROR', ev.message || 'unknown');
      // show it in the panel too, so a failure isn't a silent empty box
      if (!answer) $('#response').innerHTML =
        `<span style="color:var(--red)">⚠ ${esc(ev.message || 'Run failed.')}</span>`;
      else renderConversation(true);
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
  }
}

function renderConversation(finaldone){
  const el = $('#response');
  let html = '';
  for (const t of history){
    html += `<div class="turn"><div class="tuser">You</div><div class="ttext">${esc(t.user)}</div>`
          + `<div class="tjarvis">ATLAS</div><div class="ttext">${esc(t.assistant)}</div></div>`;
  }
  if (currentUser || answer){
    html += `<div class="turn current"><div class="tuser">You</div><div class="ttext">${esc(currentUser)}</div>`
          + `<div class="tjarvis">ATLAS</div><div class="ttext">${esc(answer)}${finaldone ? '' : '<span class="cur"></span>'}</div></div>`;
  }
  el.innerHTML = html || '<span class="rplaceholder">Standing by. Transmit an instruction.</span>';
  el.scrollTop = el.scrollHeight;
}

function cleanForSpeech(text){
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(session_id:|session:|duration:|messages:|query:|initializing agent|resume this session|hermes --resume|[-─=]{3,})/i.test(line))
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ══════════ continuous voice conversation ══════════
   Click VOICE once. From then on: listen → you stop → transcribe → Jarvis
   answers and speaks → it listens again, automatically. No re-clicking between
   turns. Click VOICE again (or press Esc) to end the conversation.

   The mic is deliberately DEAF while Jarvis is thinking or speaking (`suppress`)
   — otherwise it transcribes his own voice through the speakers and talks to
   itself forever. That's why re-arming happens only after he finishes. */
let convo = false, suppress = false;
let recognition = null;
let micStream=null, recorder=null, chunks=[], actx=null, analyser=null, vdata=null;
let vad=null, spoke=false, loudAt=0, turnStart=0;
let floorSum=0, floorN=0, threshold=0.02, peak=0, calibrating=true;
const SILENCE=5000, MIN_TURN_MS=350, MAX_TURN_MS=60000, NO_SPEECH_MS=10000;

// ── voice out ──
let muted = false, player = null;
function speak(text){
  return new Promise(resolve => {
    text = cleanForSpeech(text);
    if (muted || !text) return resolve();
    suppress = true;
    const spoken = text.length > 700 ? text.slice(0, 680).replace(/\s+\S*$/,'') + '…' : text;
    if (!RT.tts && RT.browserTts && speechSynth){
      try{
        speechSynth.cancel();
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.95; u.pitch = 0.82; u.volume = 1;
        document.body.classList.add('speaking');
        u.onend = u.onerror = () => { document.body.classList.remove('speaking'); resolve(); };
        speechSynth.speak(u);
        return;
      }catch(_){ return resolve(); }
    }
    if (!RT.tts) return resolve();
    fetch('/api/speak', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
                         body: JSON.stringify({text:spoken})})
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        if (player) player.pause();
        player = new Audio(url);
        document.body.classList.add('speaking');
        const done = () => { document.body.classList.remove('speaking');
          URL.revokeObjectURL(url); resolve(); };
        player.onended = done; player.onerror = done;
        return player.play();
      })
      .catch(() => resolve());
  });
}

// ── start / stop the whole conversation ──
async function micToggle(){
  if (convo){ stopConvo(); return; }
  // Prefer local server-side STT (Parakeet) when installed. Browser STT is unreliable
  // across Chrome profiles and often fails silently; the server receives the
  // actual microphone recording from MediaRecorder and is much more consistent.
  if (RT.stt){
    try {
      micStream = await navigator.mediaDevices.getUserMedia(
        {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
    } catch(e){ log('error','VOICE','mic blocked — allow it in the address bar'); return; }
    actx = new (window.AudioContext||window.webkitAudioContext)();
    await actx.resume();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    actx.createMediaStreamSource(micStream).connect(analyser);
    vdata = new Uint8Array(analyser.fftSize);
    convo = true; suppress = false;
    $('#mic').classList.add('on'); $('#mic').textContent = '● Parakeet Live';
    log('voice','VOICE','local voice conversation open · listening');
    beginTurn();
    return;
  }
  if (SpeechRecognition){
    convo = true; suppress = false;
    $('#mic').classList.add('on'); $('#mic').textContent = '● Browser Live';
    log('voice','VOICE','browser speech recognition open · listening');
    setState('listening','LISTENING','browser speech online');
    startBrowserRecognition();
    return;
  }
  log('error','VOICE','no speech recognition available — run ./install-voice.sh or use Chrome browser STT');
}

function stopConvo(){
  convo = false; suppress = false;
  if (recognition){ try{ recognition.onend = null; recognition.stop(); }catch(_){} recognition=null; }
  if (vad){ clearInterval(vad); vad=null; }
  if (recorder && recorder.state==='recording'){ recorder._cancel=true; try{recorder.stop();}catch(_){} }
  recorder = null;
  if (player){ try{player.pause();}catch(_){} }
  if (micStream){ micStream.getTracks().forEach(t=>t.stop()); micStream=null; }
  if (actx){ actx.close().catch(()=>{}); actx=null; analyser=null; }
  document.body.classList.remove('speaking');
  $('#mic').classList.remove('on'); $('#mic').textContent = '◉ VOICE';
  log('voice','VOICE','conversation closed');
  setState('', 'STANDBY', 'awaiting uplink');
}

// ── browser speech turn ──
function startBrowserRecognition(){
  if (!convo || suppress || !SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = '';
  recognition.onresult = e => {
    let interim = '';
    for (let i=e.resultIndex; i<e.results.length; i++){
      const txt = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += txt;
      else interim += txt;
    }
    const shown = (finalText || interim || '').trim();
    if (shown) $('#strun').textContent = 'HEARD: ' + shown.slice(0,42);
  };
  recognition.onerror = e => log('error','VOICE',`browser speech: ${e.error || 'error'}`);
  recognition.onend = async () => {
    const text = finalText.trim();
    if (!convo) return;
    if (!text){ if (!suppress) setTimeout(startBrowserRecognition, 250); return; }
    log('voice','VOICE',`browser transcribed: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);
    suppress = false;
    if (convo) setTimeout(startBrowserRecognition, 350);
  };
  setState('listening','LISTENING','browser speech online');
  try{ recognition.start(); }catch(e){ log('error','VOICE','speech recognition failed to start'); }
}

// ── one server-side local-STT listening turn ──
function beginTurn(){
  if (!convo || suppress || !micStream) return;
  chunks = []; spoke = false; peak = 0;
  floorSum = 0; floorN = 0; calibrating = true; threshold = 0.02;
  recorder = new MediaRecorder(micStream, pickMime());
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = ship;
  recorder.start(250);                          // timeslice → data flows reliably
  turnStart = loudAt = performance.now();
  setState('listening','LISTENING','listening…');
  if (!vad) vad = setInterval(vtick, 40);
}

function meter(rms){
  // live input bar in the reactor subtitle, so you can SEE it hearing you
  const n = Math.max(0, Math.min(14, Math.round(rms * 90)));
  $('#strun').textContent = 'IN ' + '▮'.repeat(n) + '▯'.repeat(14 - n);
}

function endTurn(reason){
  log('voice','VOICE',`${reason} · peak ${peak.toFixed(3)} · thr ${threshold.toFixed(3)}`);
  try { recorder.stop(); } catch(_){}           // → ship()
}

function pickMime(){
  for (const m of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if (window.MediaRecorder?.isTypeSupported?.(m)) return {mimeType:m};
  return undefined;
}

function vtick(){
  if (!analyser || suppress || !recorder || recorder.state!=='recording') return;
  analyser.getByteTimeDomainData(vdata);
  let s=0; for (let i=0;i<vdata.length;i++){ const v=(vdata[i]-128)/128; s+=v*v; }
  const rms = Math.sqrt(s/vdata.length);
  const t = performance.now();
  peak = Math.max(peak, rms);
  meter(rms);

  // first 300ms: measure the room's noise floor, set a threshold just above it
  if (calibrating){
    floorSum += rms; floorN++;
    if (t - turnStart > 300){
      const floor = floorSum / Math.max(1, floorN);
      threshold = Math.max(0.006, floor * 1.6 + 0.003);
      calibrating = false;
    }
    return;
  }

  if (rms > threshold){
    loudAt = t;
    if (!spoke){ spoke = true; log('voice','VOICE','speech detected'); }
  } else if (spoke && t - loudAt > SILENCE){
    return endTurn('silence');
  }

  // failsafes so it can never hang: cap the length, re-listen if no speech at all
  if (t - turnStart > MAX_TURN_MS) return endTurn('max-length');
  if (!spoke && t - turnStart > NO_SPEECH_MS) return endTurn('no-speech');
}

async function ship(){
  const cancel = recorder?._cancel;
  const blob = new Blob(chunks, {type: recorder?.mimeType || 'audio/webm'}); chunks=[];
  if (cancel){ return; }
  // no speech heard, too short, or too small — just listen again, don't ship ambient noise
  if (!spoke || blob.size < 1400 || performance.now()-turnStart < MIN_TURN_MS){
    if (convo && !suppress) beginTurn();
    return;
  }
  setState('running','TRANSCRIBING','…');
  log('voice','VOICE',`uploading ${Math.round(blob.size/1024)}KB to server STT`);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/listen', {method:'POST',
      headers:apiHeaders({'content-type':blob.type||'audio/webm'}), body:blob}).then(r=>r.json());
    const text = (r.text||'').trim();
    const ms = Math.round(performance.now() - t0);
    if (!text){
      log('voice','VOICE','nothing transcribed');
      if (convo) beginTurn(); else setState('','STANDBY','nothing heard');
      return;
    }
    log('voice','VOICE',`transcribed by Parakeet in ${ms}ms: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);                       // runs, then speaks; both with mic deaf
    // turn's done — hand the floor back and listen again
    suppress = false;
    if (convo) beginTurn();
  } catch(e){
    log('error','VOICE','transcription failed');
    suppress = false;
    if (convo) beginTurn(); else setState('error','FAULT','transcription failed');
  }
}

// ══════════ command matrix ══════════
function disarm(){
  document.querySelectorAll('.cmd').forEach(c=>c.classList.remove('armed'));
  $('#input').dataset.cmd = '';
}
const PAYLOAD_COMMANDS = new Set(['/goal','/browser','/background','/mission','/personality']);
$('#cmds').addEventListener('click', e => {
  const b = e.target.closest('.cmd'); if (!b) return;
  const cmd = b.dataset.cmd;
  if (running){
    log('note','BUSY',`${cmd} not sent — ATLAS is still working.`);
    return;
  }

  // Every matrix button executes its base command immediately. Commands that
  // accept an argument remain armed afterwards so the next typed or spoken
  // payload is sent as `/command payload`.
  disarm();
  if (PAYLOAD_COMMANDS.has(cmd)){
    b.classList.add('armed');
    $('#input').dataset.cmd = cmd;
    $('#input').focus();
    $('#tip').textContent = `${TIPS[cmd] || cmd} The command is live and remains armed for your next payload.`;
  } else {
    $('#tip').textContent = defaultTip;
  }
  log('command', 'COMMAND', `executing ${cmd} on Hermes backend`);
  transmit(cmd, {speak: !['/tools','/commands'].includes(cmd)});
});
const TIPS = {
  '/new':'Fresh thread — clears the Hermes conversation and starts clean.',
  '/goal':'Say your standing objective, e.g. “ship the dashboard and verify tool access”.',
  '/tools':'Shows Hermes tool status from the active profile.',
  '/toolsets':'Asks Hermes to list enabled toolsets and connected tools.',
  '/browser':'Say a Chrome/browser mission, e.g. “inspect the current tab”.',
  '/background':'Say a mission, e.g. “research competitors and save a report”.',
  '/mission':'Add or read mission queue items.',
  '/personality':'Set the persona, e.g. “calm, laconic, Stark tower operator”.',
  '/kanban':'Ask about the work queue, e.g. “what’s on my board today?”.',
  '/commands':'Show all dashboard slash commands.'
};
let defaultTip = '';

// ══════════ controls ══════════
function sendFromInput(){
  const armed = $('#input').dataset.cmd || '';
  const raw = $('#input').value.trim();
  if (!raw && !armed) return;
  const full = (armed && !raw.startsWith('/')) ? `${armed} ${raw}` : (raw || armed);
  $('#input').value = ''; disarm(); $('#tip').textContent = defaultTip;
  log('send','SEND',`transmit: ${full}`);
  transmit(full);
}
$('#run').onclick = sendFromInput;
$('#mic').onclick = micToggle;
$('#showCommands').onclick = () => transmit('/commands', {speak:false});
$('#missionBtn').onclick = () => transmit('/mission');
$('#clearBtn').onclick = () => { answer=''; currentUser=''; history=[]; renderConversation(); log('note','CLEAR','response panel cleared'); };

// ══════════ settings ══════════
$('#settingsBtn').onclick = async () => {
  try {
    const s = await fetch('/api/settings', {headers:apiHeaders()}).then(r=>r.json());
    $('#set-permission').value = s.permission || 'normal';
    $('#set-timeout').value = s.timeout ?? 120;
    $('#set-workdir').value = s.workdir || '~';
    $('#settingsOverlay').hidden = false;
  } catch(e){ log('error','SETTINGS','could not load settings'); }
};
const closeSettings = () => { $('#settingsOverlay').hidden = true; };
$('#settingsClose').onclick = closeSettings;
$('#settingsCancel').onclick = closeSettings;
$('#settingsOverlay').addEventListener('click', e => { if (e.target === $('#settingsOverlay')) closeSettings(); });
$('#settingsSave').onclick = async () => {
  const body = {
    permission: $('#set-permission').value,
    timeout: parseInt($('#set-timeout').value, 10),
    workdir: $('#set-workdir').value.trim(),
  };
  try {
    const r = await fetch('/api/settings', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body: JSON.stringify(body)}).then(r=>r.json());
    if (r.error){ log('error','SETTINGS', r.error); return; }
    log('note','SETTINGS', `saved: permission=${r.permission} timeout=${r.timeout}s workdir=${r.workdir}`);
    closeSettings();
  } catch(e){ log('error','SETTINGS','could not save settings'); }
};
document.querySelectorAll('[data-quick]').forEach(b => b.onclick = () =>
  transmit(b.dataset.quick, {speak:false}));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (running && activeController){
    fetch('/api/cancel', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:'{}'}).catch(()=>{});
    activeController.abort();
    return;
  }
  if (convo) stopConvo();
});
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  b.setAttribute('aria-label', muted ? 'Unmute Atlas' : 'Mute Atlas');
  if (muted && player) player.pause();
};
$('#input').addEventListener('keydown', e => {
  if (e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); sendFromInput(); }
});

// ══════════ system panel ══════════
function sys(id, val, cls){
  const el = $('#sy-' + id); if (!el) return;
  el.textContent = val; if (cls != null) el.className = cls;
}
// live clock in the system panel
setInterval(() => sys('clock', now()), 1000);

// poll for finished /background missions and report them when they land
setInterval(async () => {
  try {
    const j = await fetch('/api/jobs', {headers:apiHeaders()}).then(r => r.json());
    for (const d of (j.done || [])){
      log('complete','MISSION', `${d.mission} → ${(d.result||'').slice(0,200)}`);
      if (!running) speak(`Mission complete. ${(d.result||'').slice(0,300)}`);
    }
  } catch(_){}
}, 4000);

// ══════════ boot ══════════
(async () => {
  defaultTip = $('#tip').textContent;
  try {
    const s = await fetch('/api/status', {headers:apiHeaders()}).then(r=>r.json());
    RT.tts = s.tts==='kokoro' || s.tts==='local';
    RT.stt = s.stt==='parakeet';
    RT.browserStt = !!SpeechRecognition; RT.browserTts = !!speechSynth;
    const TTS_LABEL = {kokoro:'Kokoro TTS', local:'Local TTS', browser:'Browser TTS'}[s.tts] || 'Browser TTS';
    const STT_LABEL = {parakeet:'Parakeet STT', browser:'Browser STT'}[s.stt] || 'Browser STT';

    const port = location.port || '8730';
    sys('gw', `online · :${port}`, 'ok');
    sys('brain', s.runtime === 'hermes' ? 'Hermes Agent' : 'Hermes offline', s.runtime === 'hermes' ? 'ok' : 'warn');
    sys('voice', `${STT_LABEL} / ${TTS_LABEL}`, (RT.browserStt||RT.stt) ? '' : 'warn');
    sys('profile', s.profile || 'default');
    sys('runtime', s.runtime || '—', s.runtime === 'hermes' ? 'ok' : 'warn');
    sys('clock', now());
    $('#top-gw').textContent = `Gateway: online ${location.origin}`;
    $('#top-profile').textContent = 'Profile: ' + (s.profile || 'default');
    $('#top-voice').textContent = 'Voice: ' + STT_LABEL + ' / ' + TTS_LABEL;
    const tools = (s.tools || []).slice(0, 12);
    $('#toolsList').innerHTML = tools.length ? tools.map(t => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="chip ghost">Hermes tool list unavailable — set HERMES_CMD if needed</span>';

    log('status', 'BOOT',
        `gateway online · ${s.runtime} core · profile=${s.profile || 'default'} · permission=${s.permission}`);
    log('voice', 'VOICE', `channel ready — ${STT_LABEL} / ${TTS_LABEL}`);
    $('#mic').textContent = RT.stt ? '◉ Local Voice' : '◉ Browser Voice';
    setState('', 'STANDBY', 'awaiting uplink');

    // load prior conversation turns (persisted server-side)
    try {
      const h = await fetch('/api/history', {headers:apiHeaders()}).then(r=>r.json());
      history = h.history || [];
    } catch(_) { history = []; }
    renderConversation();
  } catch(e){
    sys('gw','offline','warn');
    log('error','STATUS','server unreachable');
  }
})();

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

// ══════════ mic gate: Space latch · mic light · auto-close · call mode ══════════
(() => {
  const LS = k => 'jarvis.' + k;
  let idleSec = parseInt(localStorage.getItem(LS('micIdle')) ?? '60', 10);
  if (!(idleSec >= 0)) idleSec = 60;
  let callMode = false, premuted = false, lastActive = Date.now(), pending = false;
  const bar = $('#micbar'), word = $('#micWord'), hint = $('#micHint');

  // ── chimes (soft, skipped when Jarvis is muted / in call mode) ──
  let cctx = null;
  function chime(up){
    if (muted || callMode) return;
    try {
      cctx = cctx || new (window.AudioContext || window.webkitAudioContext)();
      const t = cctx.currentTime, notes = up ? [660, 880] : [880, 560];
      notes.forEach((f, i) => {
        const o = cctx.createOscillator(), g = cctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + i*.09); g.gain.linearRampToValueAtTime(.06, t + i*.09 + .015);
        g.gain.exponentialRampToValueAtTime(.0001, t + i*.09 + .16);
        o.connect(g).connect(cctx.destination); o.start(t + i*.09); o.stop(t + i*.09 + .18);
      });
    } catch(_){}
  }

  // ── tab title + favicon so the state is visible even from another window ──
  const fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav);
  const COLORS = {ask:'#ffb648', closed:'#4a5f6a', listening:'#ff5566', busy:'#ffb648', call:'#a884ff', closing:'#ff5566'};
  const TITLES = {ask:'🟠 ATLAS · needs your OK', closed:'ATLAS · mic closed', listening:'🔴 ATLAS · listening', busy:'🟠 ATLAS · working', call:'🟣 ATLAS · call mode', closing:'🔴 ATLAS · closing…'};

  function stateNow(){
    if (callMode) return 'call';
    if (window.__approvalOpen) return 'ask';
    if (!convo) return 'closed';
    if (suppress || document.body.classList.contains('running') || document.body.classList.contains('speaking')) return 'busy';
    return 'listening';
  }
  let shown = '';
  function render(){
    let st = stateNow();
    let left = null;
    if (st === 'listening' && idleSec > 0){
      left = Math.ceil(idleSec - (Date.now() - lastActive) / 1000);
      if (left <= 10) st = 'closing';
    }
    const key = st + ':' + left;
    if (key === shown) return; shown = key;
    bar.dataset.state = st;
    document.body.classList.toggle('micopen', convo && !callMode);
    document.body.classList.toggle('micclosed', !convo || callMode);
    const T = {
      closed:   ['MIC CLOSED', 'Press <kbd>Space</kbd> to open'],
      listening:['LISTENING', 'Press <kbd>Space</kbd> to close'],
      closing:  ['LISTENING', `Closing in ${Math.max(left,0)}s — speak to keep it open`],
      ask:      ['AWAITING YOUR ANSWER', 'Say <kbd>yes</kbd> or <kbd>no</kbd> — or <kbd>Enter</kbd> / <kbd>Esc</kbd>'],
      busy:     ['PAUSED', 'Atlas is working — mic resumes after'],
      call:     ['CALL MODE', 'Silent · mic locked · <kbd>Alt</kbd>+<kbd>C</kbd> to exit'],
    }[st];
    word.textContent = T[0]; hint.innerHTML = T[1];
    document.title = TITLES[st];
    fav.href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="${COLORS[st]}"/></svg>`);
  }

  function toast(msg){
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }

  // ── open / close the mic ──
  async function toggleMic(){
    if (pending) return;
    if (window.__approvalOpen) return;          // the approval prompt owns the mic right now
    if (callMode){ toast('Call mode is on — press Alt+C to exit first'); return; }
    pending = true;
    if (window.__greetNow) { try { await window.__greetNow(); } catch(_){} }
    try {
      if (convo){ stopConvo(); chime(false); }
      else { lastActive = Date.now(); await micToggle(); if (convo) chime(true); }
    } finally { pending = false; render(); }
  }
  // clicking the Voice button should feel identical (chime + idle clock)
  $('#mic').addEventListener('click', e => { if (callMode){ e.stopImmediatePropagation(); toast('Call mode is on — press Alt+C to exit first'); } }, true);
  $('#mic').addEventListener('click', () => { lastActive = Date.now(); setTimeout(render, 50); });

  // ── auto-close: any speech / thinking / speaking counts as activity ──
  setInterval(() => {
    if (convo && (spoke || suppress || document.body.classList.contains('running') || document.body.classList.contains('speaking')))
      lastActive = Date.now();
    if (convo && !callMode && idleSec > 0 && Date.now() - lastActive > idleSec * 1000 && !suppress){
      stopConvo(); chime(false);
      log('voice', 'VOICE', `mic auto-closed after ${idleSec}s of silence`);
      toast('Mic closed — silence timeout');
    }
    render();
  }, 500);
  new MutationObserver(render).observe(document.body, {attributes:true, attributeFilter:['class']});
  new MutationObserver(render).observe($('#mic'), {attributes:true, attributeFilter:['class']});

  // ── call mode: no listening, no speaking — text only ──
  function setCall(on){
    if (on === callMode) return;
    callMode = on;
    if (on){
      premuted = muted;
      if (convo) stopConvo();
      if (!muted) $('#mute').click();
      try { speechSynth?.cancel(); } catch(_){}
      if (player) try { player.pause(); } catch(_){}
      log('note', 'CALL', 'call mode on — mic locked, replies are text only');
    } else {
      if (muted && !premuted) $('#mute').click();
      log('note', 'CALL', 'call mode off');
    }
    $('#callBtn').setAttribute('aria-pressed', String(on));
    toast(on ? 'Call mode on — silent, mic locked' : 'Call mode off');
    shown = ''; render();
  }
  $('#callBtn').addEventListener('click', () => setCall(!callMode));

  // ── keys: Space = latch mic, C = call mode (never while typing) ──
  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  // an empty composer counts as "not typing" for Space: a leading space is meaningless there
  const emptyComposer = () => document.activeElement === $('#input') && !$('#input').value;
  const spaceFree = () => !typing() || emptyComposer();
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey && spaceFree()){
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat){ document.activeElement?.blur?.(); toggleMic(); }
      return;
    }
    // call mode: Alt+C anywhere, or plain C when not typing
    const isC = e.code === 'KeyC';
    if (isC && !e.repeat && !e.metaKey && !e.ctrlKey && $('#settingsOverlay').hidden && (e.altKey || !typing())){
      e.preventDefault(); setCall(!callMode);
    }
  }, true);
  document.addEventListener('keyup', e => {          // stop a focused button from "clicking" on Space release
    if (e.code === 'Space' && spaceFree()) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ── settings field ──
  $('#settingsBtn').addEventListener('click', () => { $('#set-micidle').value = idleSec; });
  $('#settingsSave').addEventListener('click', () => {
    const v = parseInt($('#set-micidle').value, 10);
    if (v >= 0){ idleSec = v; localStorage.setItem(LS('micIdle'), String(v)); }
  });

  $('#mic').title = 'Open / close the mic (Space)';
  render();
})();

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

    // once per server launch, and at most once per calendar day
    const mark = g.boot_id + ':' + new Date().toDateString();
    if (localStorage.getItem(GKEY) === mark) return;

    const speakIt = () => {
      if (!armed) return Promise.resolve();
      armed = null; window.__greetNow = null;
      localStorage.setItem(GKEY, mark);
      log('voice', 'GREETING', text);
      return speak(text);                       // honours mute / call mode (speak() no-ops when muted)
    };
    armed = speakIt;
    // Browsers block audio until the page has been touched, so wait for the first gesture.
    window.__greetNow = speakIt;
    if (navigator.userActivation?.hasBeenActive) { speakIt(); return; }
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

// ══════════ approvals: ask out loud, answer by voice or key ══════════
(() => {
  const card = $('#approval');
  const TTL = 45;                       // seconds of silence before it counts as "no"
  const YES = /\b(yes|yeah|yep|yup|sure|okay|ok|approve|approved|go ahead|do it|proceed|confirm|affirmative)\b/i;
  const NO  = /\b(no|nope|nah|don'?t|do not|deny|denied|stop|cancel|negative|abort|never)\b/i;
  let cur = null, shownAt = 0, tick = null, listening = null;
  const callOn = () => $('#callBtn').getAttribute('aria-pressed') === 'true';
  const voiceOK = () => !callOn() && !muted;

  const parse = t => NO.test(t) ? 'deny' : (YES.test(t) ? 'once' : null);   // any "no" wins

  function render(ev){
    const high = ev.risk === 'high';
    $('#apBadge').textContent = high ? 'NEEDS YOUR OK · CONFIRM WITH KEYBOARD' : 'NEEDS YOUR OK';
    $('#apBadge').classList.toggle('high', high);
    $('#apTitle').textContent = `Atlas wants to run: ${ev.description}.`;
    $('#apCmd').textContent = ev.command || '(no command text)';
    $('#apHint').textContent = high
      ? 'This kind of action needs a deliberate keypress — a spoken "yes" is not accepted. You can still say "no".'
      : (voiceOK() ? 'Say "yes" or "no", or use the buttons.' : 'Use the buttons or the keyboard.');
    card.hidden = false;
  }

  function close(){
    cur = null; window.__approvalOpen = false;
    clearInterval(tick); tick = null; card.hidden = true;
    if (listening){ listening.cancel(); listening = null; }
  }

  async function answer(choice, via){
    const ev = cur; if (!ev) return;
    close();
    try {
      const r = await fetch('/api/approval', {method:'POST', headers: apiHeaders({'content-type':'application/json'}),
        body: JSON.stringify({run_id: ev.run_id, request_id: ev.request_id, choice})}).then(r => r.json());
      if (!r.ok) log('error', 'APPROVAL', 'could not deliver answer: ' + (r.error || 'unknown'));
    } catch(_){ log('error', 'APPROVAL', 'could not deliver answer'); }
    log('command', 'APPROVAL', `${choice === 'once' ? 'approved once' : 'denied'} (${via}): ${ev.description}`);
  }

  // ── listen for a short spoken answer ──
  function listenOnce(maxMs){
    const ctl = {stop: false, cancel(){ this.stop = true; }};
    const p = (async () => {
      if (RT.stt){                                         // local Parakeet: record, VAD, upload
        let stream, ac;
        try {
          stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
          ac = new (window.AudioContext || window.webkitAudioContext)(); await ac.resume();
          const an = ac.createAnalyser(); an.fftSize = 1024;
          ac.createMediaStreamSource(stream).connect(an);
          const data = new Uint8Array(an.fftSize), chunks = [];
          const rec = new MediaRecorder(stream, pickMime()); rec.ondataavailable = e => e.data?.size && chunks.push(e.data);
          rec.start(250);
          const t0 = performance.now(); let last = t0, spoke = false, floor = 0, n = 0, thr = 0.02;
          await new Promise(res => {
            const iv = setInterval(() => {
              an.getByteTimeDomainData(data);
              let sum = 0; for (const v of data){ const x = (v-128)/128; sum += x*x; }
              const rms = Math.sqrt(sum/data.length), now = performance.now();
              if (now - t0 < 300){ floor += rms; n++; thr = Math.max(0.006, (floor/n)*1.6 + 0.003); }
              else if (rms > thr){ spoke = true; last = now; }
              if (ctl.stop || (spoke && now - last > 900) || (!spoke && now - t0 > maxMs) || now - t0 > 9000){ clearInterval(iv); res(); }
            }, 40);
          });
          const blob = await new Promise(res => { rec.onstop = () => res(new Blob(chunks, {type: rec.mimeType || 'audio/webm'})); try{ rec.stop(); }catch(_){ res(null); } });
          if (ctl.stop || !blob || blob.size < 1400) return '';
          const r = await fetch('/api/listen', {method:'POST', headers: apiHeaders({'content-type': blob.type || 'audio/webm'}), body: blob}).then(r => r.json());
          return (r.text || '').trim();
        } catch(_){ return ''; }
        finally { stream?.getTracks().forEach(t => t.stop()); ac?.close().catch(()=>{}); }
      }
      if (SpeechRecognition){                              // browser fallback
        return await new Promise(res => {
          const r = new SpeechRecognition(); r.lang = 'en-US'; r.continuous = false; r.interimResults = false;
          let out = ''; r.onresult = e => { out = e.results[0][0].transcript; }; r.onend = () => res(out); r.onerror = () => res('');
          ctl.cancel = () => { ctl.stop = true; try{ r.abort(); }catch(_){} };
          try{ r.start(); setTimeout(() => { try{ r.stop(); }catch(_){} }, maxMs); } catch(_){ res(''); }
        });
      }
      return '';
    })();
    ctl.result = p; return ctl;
  }

  async function voiceLoop(ev){
    for (let attempt = 0; attempt < 2 && cur === ev; attempt++){
      listening = listenOnce(10000);
      const heard = await listening.result;
      if (cur !== ev) return;                              // answered another way meanwhile
      const choice = parse(heard);
      if (heard) log('voice', 'VOICE', `approval answer heard: "${heard}"`);
      if (choice === 'deny') return answer('deny', 'voice');
      if (choice === 'once'){
        if (ev.risk === 'high'){ await speak('That one needs the keyboard. Press Enter to approve.'); return; }
        return answer('once', 'voice');
      }
      if (attempt === 0) await speak("Sorry, yes or no?");
    }
  }

  async function onApproval(ev){
    if (cur) return;
    cur = ev; shownAt = Date.now(); window.__approvalOpen = true;
    render(ev); log('command', 'APPROVAL', `asked: ${ev.description} — ${(ev.command || '').slice(0, 120)}`);
    setState('', 'AWAITING OK', ev.description.slice(0, 32));
    let left = TTL; $('#apTimer').textContent = `${left}s`;
    tick = setInterval(() => {
      left--; $('#apTimer').textContent = `${Math.max(left,0)}s`;
      if (left <= 0){ toast('No answer — denied'); answer('deny', 'timeout'); }
    }, 1000);
    if (voiceOK()){
      await speak(`I need your approval for a ${ev.description}. The command is on screen. `
        + (ev.risk === 'high' ? 'Press Enter to approve, or Escape to deny.' : 'Say yes or no.'));
      if (cur === ev && !callOn()) voiceLoop(ev);
    }
  }

  // buttons + keys (Esc always denies; Enter only approves when it can't be a stray keystroke)
  $('#apOk').addEventListener('click', () => answer('once', 'click'));
  $('#apDeny').addEventListener('click', () => answer('deny', 'click'));
  document.addEventListener('keydown', e => {
    if (!cur) return;
    if (e.key === 'Escape'){ e.preventDefault(); e.stopImmediatePropagation(); answer('deny', 'key'); return; }
    if (e.key === 'Enter' && !e.shiftKey){
      const typing = document.activeElement === $('#input') && $('#input').value.trim();
      if (typing || Date.now() - shownAt < 800) return;     // never approve by accident while typing
      e.preventDefault(); e.stopImmediatePropagation(); answer('once', 'key');
    }
  }, true);

  // route the new stream events (everything else flows to the original handler untouched)
  const original = handle;
  handle = ev => {
    if (ev.t === 'approval') return onApproval(ev);
    if (ev.t === 'approval_done' && cur && ev.request_id === cur.request_id) close();
    if ((ev.t === 'complete' || ev.t === 'error') && cur) close();
    return original(ev);
  };
})();

// ══════════ settings: provider + model (read-only) ══════════
(() => {
  const btn = $('#settingsBtn'); if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const s = await fetch('/api/settings', {headers: apiHeaders()}).then(r => r.json());
      $('#set-provider').value = s.model_provider || '';
      $('#set-model').value = s.model_name || '';
    } catch (_) {}
  });
})();

// ══════════ living orb: breathes idle · tightens to your voice · vibrates to Jarvis ══════════
(() => {
  const cv = document.getElementById('orbCanvas'); if (!cv) return;
  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1;
  const fit = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
  };
  new ResizeObserver(fit).observe(cv); fit();

  // ── input levels ──
  let micLvl = 0;                                   // fed by the existing mic meter
  const prevMeter = window.meter;
  if (typeof prevMeter === 'function') window.meter = rms => { micLvl = Math.min(1, rms * 7); return prevMeter(rms); };

  let outCtx = null, outAn = null, outData = null, wired = null;
  function outLevel(){                              // real loudness of Jarvis's voice
    try {
      if (player && wired !== player){
        outCtx = outCtx || new (window.AudioContext || window.webkitAudioContext)();
        const src = outCtx.createMediaElementSource(player);
        outAn = outCtx.createAnalyser(); outAn.fftSize = 512; outData = new Uint8Array(outAn.fftSize);
        src.connect(outAn); outAn.connect(outCtx.destination);
        outCtx.resume().catch(() => {}); wired = player;
      }
      if (outAn && player && !player.paused && wired === player){
        outAn.getByteTimeDomainData(outData);
        let s = 0; for (const v of outData){ const x = (v - 128) / 128; s += x * x; }
        return Math.min(1, Math.sqrt(s / outData.length) * 5);
      }
    } catch (_) { wired = player; }
    return null;
  }

  // ── look per state ──
  const LOOK = {
    idle:      {c:[79,170,245],  glow:.35, r:.19},
    listening: {c:[79,235,230],  glow:.65, r:.20},
    speaking:  {c:[168,132,255], glow:.75, r:.20},
    thinking:  {c:[255,182,72],  glow:.55, r:.19},
    error:     {c:[255,107,120], glow:.6,  r:.19},
    done:      {c:[62,232,168],  glow:.55, r:.19},
  };
  const cur = {c:[79,170,245], glow:.35, r:.19, lvl:0, spin:0};
  // orb colours come from the active theme (--orb-* variables), so every theme has its own palette
  const rgbVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim().split(',').map(Number);
  const readLook = () => {
    const src = {idle:'--orb-idle', listening:'--orb-listen', speaking:'--orb-speak', thinking:'--orb-think'};
    for (const k in src){ const v = rgbVar(src[k]); if (v.length === 3 && v.every(Number.isFinite)) LOOK[k].c = v; }
    const st = document.querySelector('.stage');                 // layouts shrink the canvas, so they also scale the orb
    const sc = parseFloat(st && getComputedStyle(st).getPropertyValue('--orb-scale'));
    orbScale = Number.isFinite(sc) && sc > 0 ? sc : 1;
  };
  let orbScale = 1;
  readLook(); cur.c = LOOK.idle.c.slice();
  addEventListener('atlas-theme', readLook);
  const mix = (a, b, k) => a + (b - a) * k;
  const ripples = []; let lastRip = 0;
  let t0 = performance.now();

  function frame(now){
    requestAnimationFrame(frame);
    if (!W) return;
    const t = (now - t0) / 1000, cl = document.body.classList;
    const state = cl.contains('error') ? 'error'
                : cl.contains('speaking') ? 'speaking'
                : cl.contains('listening') ? 'listening'
                : cl.contains('running') ? 'thinking'
                : cl.contains('done') ? 'done' : 'idle';
    const L = LOOK[state];

    // target level for this state
    let target = 0;
    if (state === 'speaking'){
      const o = outLevel();
      target = o != null ? o : 0.35 + 0.25 * Math.sin(t * 9) * Math.sin(t * 3.1) + 0.12 * Math.sin(t * 17);
    } else if (state === 'listening'){
      target = micLvl;
    } else if (state === 'thinking'){
      target = 0.18 + 0.1 * Math.sin(t * 2.4);
    }
    micLvl *= 0.9;                                  // decay when the meter goes quiet
    const k = target > cur.lvl ? 0.35 : 0.08;       // fast attack, slow release
    cur.lvl = mix(cur.lvl, Math.max(0, target), k);
    for (let i = 0; i < 3; i++) cur.c[i] = mix(cur.c[i], L.c[i], 0.06);
    cur.glow = mix(cur.glow, L.glow, 0.06); cur.r = mix(cur.r, L.r, 0.06);
    cur.spin += (state === 'thinking' ? 0.9 : 0.15) / 60;

    const S = Math.min(W, H), cx = W / 2, cy = H / 2;
    const breathe = reduce ? 0 : Math.sin(t * 1.5) * 0.025;
    // listening: orb tightens as you speak; speaking: swells with the voice
    let R = S * cur.r * orbScale * (1 + breathe);
    if (state === 'listening') R *= 1 - cur.lvl * 0.16;
    else if (state === 'speaking') R *= 1 + cur.lvl * 0.14;
    const [r, g, b] = cur.c.map(Math.round), col = a => `rgba(${r},${g},${b},${a})`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // soft outer glow
    const gr = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, S * 0.5);
    gr.addColorStop(0, col(0.30 * cur.glow + cur.lvl * 0.25));
    gr.addColorStop(0.45, col(0.10 * cur.glow));
    gr.addColorStop(1, col(0));
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);

    // ripples: your voice sends rings inward-out, mine sends them outward
    if (!reduce && (state === 'speaking' || state === 'listening') && cur.lvl > 0.12 && now - lastRip > 260 - cur.lvl * 120){
      ripples.push({born: now, dir: state === 'speaking' ? 1 : -1, a: 0.2 + cur.lvl * 0.4}); lastRip = now;
    }
    for (let i = ripples.length - 1; i >= 0; i--){
      const p = ripples[i], age = (now - p.born) / 1400;
      if (age >= 1){ ripples.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - age, 2);
      const rr = p.dir > 0 ? mix(R * 1.05, S * 0.48, e) : mix(S * 0.48, R * 1.05, e);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = col(p.a * (1 - age)); ctx.lineWidth = 1.5; ctx.stroke();
    }

    // the orb body: a soft blob whose edge vibrates with the level
    const N = 96, amp = reduce ? 0 : (state === 'speaking' ? 0.10 : state === 'listening' ? 0.05 : state === 'thinking' ? 0.03 : 0.012) * (0.3 + cur.lvl * 2.2);
    ctx.beginPath();
    for (let i = 0; i <= N; i++){
      const a = (i / N) * Math.PI * 2;
      const wob = Math.sin(a * 3 + t * 2.1 + cur.spin * 6) * 0.5
                + Math.sin(a * 5 - t * 3.3) * 0.3
                + Math.sin(a * 9 + t * (state === 'speaking' ? 14 : 5)) * 0.2 * (0.4 + cur.lvl * 2);
      const rad = R * (1 + wob * amp * 2.2);
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    const body = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R * 1.15);
    body.addColorStop(0, `rgba(255,255,255,${0.85})`);
    body.addColorStop(0.35, col(0.95));
    body.addColorStop(1, `rgba(${Math.round(r * 0.18)},${Math.round(g * 0.18)},${Math.round(b * 0.28)},0.95)`);
    ctx.shadowColor = col(0.8); ctx.shadowBlur = 28 + cur.lvl * 50;
    ctx.fillStyle = body; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(234,246,250,.55)'; ctx.stroke();
  }
  requestAnimationFrame(frame);
})();

// ══════════ second brain: force-directed graph of the Atlas notes ══════════
(() => {
  const ov = document.getElementById('brainOverlay'); if (!ov) return;
  const cv = document.getElementById('brainCanvas'), ctx = cv.getContext('2d');
  const $b = id => document.getElementById(id);
  const GROUP = {'research-strategy':[79,230,245], 'design-content':[168,132,255], 'marketing':[255,182,72],
                 'business-operations':[62,232,168], 'finance':[255,120,170]};
  const NAMES = {'research-strategy':'Research & Strategy', 'design-content':'Design & Content', 'marketing':'Marketing',
                 'business-operations':'Business & Operations', 'finance':'Finance'};
  const RADIUS = {hub:16, dept:11, sub:6.5, notebook:3.5, commons:6, log:4, other:4};
  const colorOf = n => n.type === 'hub' ? HUB : (GROUP[n.group] || [130,160,180]);
  let INK = '234,246,250', HUB = [240,250,255];
  const readTheme = () => {
    const cs = getComputedStyle(document.documentElement);
    INK = cs.getPropertyValue('--ink-rgb').trim() || INK;
    const h = cs.getPropertyValue('--hub-rgb').trim().split(',').map(Number);
    if (h.length === 3 && h.every(Number.isFinite)) HUB = h;
  };
  readTheme(); addEventListener('atlas-theme', readTheme);
  $b('brLegend').innerHTML = Object.keys(GROUP).map(k =>
    `<span><i style="background:rgb(${GROUP[k].join(',')})"></i>${NAMES[k]}</span>`).join('')
    + '<span><i style="background:rgb(var(--hub-rgb))"></i>Atlas hub</span><span style="margin-left:auto">drag nodes · scroll to zoom · click to read</span>';

  let nodes = [], links = [], byId = new Map(), adj = new Map();
  let W = 0, H = 0, dpr = 1, raf = 0, alpha = 1;
  let view = {x:0, y:0, k:1}, hover = null, selected = null, drag = null, pan = null, moved = false;

  const fit = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
  };
  new ResizeObserver(fit).observe(cv);

  const showNb = () => $b('brNotebooks').checked, showSh = () => $b('brShared').checked;
  const visible = n => n.type === 'notebook' ? showNb() : (n.type === 'commons' || n.type === 'log') ? showSh() : true;

  async function load(){
    try {
      const g = await fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json());
      if (!g.nodes) throw 0;
      const old = new Map(nodes.map(n => [n.id, n]));
      nodes = g.nodes.map((n, i) => {
        const o = old.get(n.id), a = (i / g.nodes.length) * Math.PI * 2;
        return Object.assign(n, {x: o ? o.x : Math.cos(a) * 220 + Math.random() * 20,
                                 y: o ? o.y : Math.sin(a) * 220 + Math.random() * 20, vx: 0, vy: 0});
      });
      byId = new Map(nodes.map(n => [n.id, n]));
      links = g.links.map(l => ({a: byId.get(l.source), b: byId.get(l.target)})).filter(l => l.a && l.b);
      adj = new Map(nodes.map(n => [n.id, new Set()]));
      links.forEach(l => { adj.get(l.a.id).add(l.b.id); adj.get(l.b.id).add(l.a.id); });
      alpha = 1;
      for (let i = 0; i < 320; i++) step();     // open already settled, not mid-scramble
      alpha = .05;
      if (!g.exists) $b('brTitle').textContent = 'No brain folder found at ' + g.root;
    } catch (_) { $b('brTitle').textContent = 'Could not load the brain'; }
  }

  const structural = l => { const t = [l.a.type, l.b.type]; return t.includes('hub') || t.includes('notebook') || (t.includes('dept') && t.includes('sub')); };
  const restLen = l => {
    const t = [l.a.type, l.b.type];
    return t.includes('hub') ? 160 : (t.includes('dept') && t.includes('sub')) ? 100 : t.includes('notebook') ? 34 : 190;
  };

  function step(){
    const vis = nodes.filter(visible), n = vis.length;
    for (let i = 0; i < n; i++){
      const a = vis[i];
      for (let j = i + 1; j < n; j++){
        const b = vis[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 160000) continue;
        const f = (4200 / d2) * alpha, d = Math.sqrt(d2);
        dx = dx / d * f; dy = dy / d * f;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
    }
    for (const l of links){
      if (!visible(l.a) || !visible(l.b)) continue;
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - restLen(l)) * (structural(l) ? 0.035 : 0.008) * alpha, fx = dx / d * f, fy = dy / d * f;
      l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
    }
    for (const a of vis){
      a.vx -= a.x * 0.004 * alpha; a.vy -= a.y * 0.004 * alpha;
      if (a === drag){ a.vx = a.vy = 0; continue; }
      a.vx *= 0.82; a.vy *= 0.82; a.x += a.vx; a.y += a.vy;
    }
    alpha = Math.max(0.02, alpha * 0.985);
    let mx = 0, my = 0;                                   // keep the whole graph centred on the canvas
    for (const a of vis){ mx += a.x; my += a.y; }
    if (n){ mx /= n; my /= n; for (const a of vis){ a.x -= mx * 0.2; a.y -= my * 0.2; } }
  }

  function fitView(){                                     // zoom so every visible node fits with margin
    const vis = nodes.filter(visible); if (!vis.length || !W) return;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const a of vis){ x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); y0 = Math.min(y0, a.y); y1 = Math.max(y1, a.y); }
    const k = Math.min((W - 140) / Math.max(1, x1 - x0), (H - 110) / Math.max(1, y1 - y0));
    view.k = Math.max(.45, Math.min(1.5, k)); view.x = -((x0 + x1) / 2) * view.k; view.y = -((y0 + y1) / 2) * view.k;
  }

  const toWorld = (px, py) => ({x: (px - W / 2 - view.x) / view.k, y: (py - H / 2 - view.y) / view.k});
  const pick = (px, py) => {
    const w = toWorld(px, py); let best = null, bd = 1e9;
    for (const n of nodes){
      if (!visible(n)) continue;
      const r = (RADIUS[n.type] || 4) + 5 / view.k, d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < r && d < bd){ best = n; bd = d; }
    }
    return best;
  };

  function draw(){
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.translate(W / 2 + view.x, H / 2 + view.y); ctx.scale(view.k, view.k);
    const focus = selected || hover, near = focus ? adj.get(focus.id) : null;
    for (const l of links){
      if (!visible(l.a) || !visible(l.b)) continue;
      const hot = focus && (l.a === focus || l.b === focus), c = colorOf(l.a.type === 'hub' ? l.b : l.a);
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y);
      ctx.strokeStyle = `rgba(${c.join(',')},${hot ? .85 : focus ? .06 : .22})`; ctx.lineWidth = (hot ? 1.8 : 1) / view.k; ctx.stroke();
    }
    for (const n of nodes){
      if (!visible(n)) continue;
      const c = colorOf(n), r = RADIUS[n.type] || 4;
      const dim = focus && n !== focus && !(near && near.has(n.id));
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.join(',')},${dim ? .18 : .95})`;
      ctx.shadowColor = `rgba(${c.join(',')},.8)`; ctx.shadowBlur = dim ? 0 : (n.type === 'notebook' ? 4 : 14);
      ctx.fill(); ctx.shadowBlur = 0;
      if (n === selected){ ctx.lineWidth = 2 / view.k; ctx.strokeStyle = `rgb(${INK})`; ctx.stroke(); }
    }
    ctx.font = `${11 / Math.max(.7, Math.min(1.4, view.k))}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const n of nodes){
      if (!visible(n)) continue;
      const show = n.type === 'hub' || n.type === 'dept' || n === focus || (near && near.has(n.id) && n.type !== 'notebook')
                   || (n.type === 'sub' && view.k > .85);
      if (!show) continue;
      const dim = focus && n !== focus && !(near && near.has(n.id));
      ctx.fillStyle = dim ? `rgba(${INK},.3)` : `rgba(${INK},.92)`;
      ctx.fillText(n.id.replace(/-/g, ' '), n.x, n.y + (RADIUS[n.type] || 4) + 13 / Math.max(.7, view.k));
    }
    ctx.restore();
  }

  function loop(){ raf = requestAnimationFrame(loop); if (W) { step(); draw(); } }

  async function openNote(n){
    selected = n; alpha = Math.max(alpha, .15);
    $b('brTitle').textContent = n.id; $b('brPath').textContent = ''; $b('brText').textContent = 'loading…';
    const box = $b('brLinks'); box.textContent = '';
    for (const id of [...(adj.get(n.id) || [])].sort()){
      const b = document.createElement('button'); b.textContent = id.replace(/-/g, ' ');
      b.onclick = () => { const t = byId.get(id); if (t){ if (!visible(t)) { if (t.type === 'notebook') $b('brNotebooks').checked = true; else $b('brShared').checked = true; } openNote(t); } };
      box.appendChild(b);
    }
    try {
      const r = await fetch('/api/brain/note?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(r => r.json());
      if (selected !== n) return;
      $b('brPath').textContent = r.path || ''; $b('brText').textContent = r.text || r.error || '';
    } catch (_) { $b('brText').textContent = 'could not load note'; }
  }

  const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); const [px, py] = pos(e); moved = false;
    const n = pick(px, py);
    if (n){ drag = n; } else { pan = {x: e.clientX, y: e.clientY, vx: view.x, vy: view.y}; cv.classList.add('drag'); }
  });
  cv.addEventListener('pointermove', e => {
    const [px, py] = pos(e);
    if (drag){ const w = toWorld(px, py); drag.x = w.x; drag.y = w.y; alpha = Math.max(alpha, .3); moved = true; }
    else if (pan){ view.x = pan.vx + e.clientX - pan.x; view.y = pan.vy + e.clientY - pan.y; moved = true; }
    else hover = pick(px, py);
  });
  cv.addEventListener('pointerup', e => {
    const [px, py] = pos(e);
    if (!moved){ const n = pick(px, py); if (n) openNote(n); else selected = null; }
    drag = null; pan = null; cv.classList.remove('drag');
  });
  cv.addEventListener('pointerleave', () => { hover = null; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const [px, py] = pos(e), before = toWorld(px, py);
    view.k = Math.max(.35, Math.min(3, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    view.x = px - W / 2 - before.x * view.k; view.y = py - H / 2 - before.y * view.k;
  }, {passive: false});

  const open = async () => {
    ov.hidden = false; fit(); view = {x: 0, y: 0, k: 1};
    await load(); fitView(); cancelAnimationFrame(raf); loop();
  };
  const close = () => { ov.hidden = true; cancelAnimationFrame(raf); };
  $b('navBrain').addEventListener('click', open);
  $b('brainClose').addEventListener('click', close);
  $b('brRefresh').addEventListener('click', load);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden) close(); });
  [$b('brNotebooks'), $b('brShared')].forEach(c => c.addEventListener('change', () => { alpha = 1; }));
})();

// ══════════ themes · layouts · department rail ══════════
(() => {
  const root = document.documentElement;
  // each theme ships a light and a dark variant (see themes.css); sw = [bg, accent] preview, r = corner radius preview
  const THEMES = [
    {id:'atlas',     label:'Atlas',     r:'8px',  d:['#071420', '#4fe6f5'], l:['#eaf2fb', '#1f6fe0']},
    {id:'terminal',  label:'Terminal',  r:'0',    d:['#06120a', '#3dff8a'], l:['#e9ecdc', '#0a6b34']},
    {id:'folio',     label:'Folio',     r:'1px',  d:['#1c1813', '#e2b765'], l:['#f1ecdf', '#8c2f24']},
    {id:'brutal',    label:'Brutal',    r:'0',    d:['#0c0c0c', '#ffe14a'], l:['#fff1c9', '#d6125a']},
    {id:'aurora',    label:'Aurora',    r:'14px', d:['#15173a', '#c58bff'], l:['#f5f0ff', '#6a3fd8']},
    {id:'blueprint', label:'Blueprint', r:'1px',  d:['#0a2540', '#8fd6ff'], l:['#f2f6fb', '#12509e']},
    {id:'clay',      label:'Clay',      r:'12px', d:['#25272d', '#ff9a6a'], l:['#e6e0d6', '#c4562a']},
  ];
  const MODES = [{id:'dark', label:'Dark', ico:'☾'}, {id:'light', label:'Light', ico:'☀'}, {id:'auto', label:'Auto', ico:'◐'}];
  const LAYOUTS = [
    {id:'classic', label:'Classic', parts:2},
    {id:'focus',   label:'Focus',   parts:2},
    {id:'command', label:'Command', parts:3},
  ];
  const curTheme = () => root.dataset.theme || 'atlas';
  const curPref = () => root.dataset.pref || 'dark';
  const curMode = () => root.dataset.mode || 'dark';
  const mq = matchMedia('(prefers-color-scheme: light)');
  const curLayout = () => root.dataset.layout || 'classic';
  const store = (k, v) => { try { v ? localStorage.setItem('jarvis.' + k, v) : localStorage.removeItem('jarvis.' + k); } catch (_) {} };

  function mark(){
    document.querySelectorAll('[data-theme-id]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.themeId === curTheme()));
      const t = THEMES.find(x => x.id === b.dataset.themeId), c = curMode() === 'light' ? t.l : t.d;
      const i = b.querySelector('i'); i.style.background = `linear-gradient(135deg,${c[0]} 52%,${c[1]} 52%)`;
    });
    document.querySelectorAll('[data-mode-id]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modeId === curPref())));
    document.querySelectorAll('[data-layout-id]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layoutId === curLayout())));
    const mb = $('#modeBtn'); if (mb){ mb.textContent = curMode() === 'light' ? '☀' : '☾'; mb.title = `${curMode() === 'light' ? 'Light' : 'Dark'} mode — click to switch`; }
  }
  function setTheme(id){
    root.dataset.theme = id; store('theme', id);
    mark(); dispatchEvent(new Event('atlas-theme'));
  }
  function setMode(pref){                       // dark | light | auto (follows the system)
    root.dataset.pref = pref; store('mode', pref);
    root.dataset.mode = pref === 'auto' ? (mq.matches ? 'light' : 'dark') : pref;
    mark(); dispatchEvent(new Event('atlas-theme'));
  }
  mq.addEventListener && mq.addEventListener('change', () => { if (curPref() === 'auto') setMode('auto'); });
  function setLayout(id){
    if (id === 'classic') delete root.dataset.layout; else root.dataset.layout = id;
    store('layout', id === 'classic' ? '' : id);
    mark(); dispatchEvent(new Event('resize')); dispatchEvent(new Event('atlas-theme'));
  }

  const build = (host, items, mk) => items.forEach(it => host.appendChild(mk(it)));
  const swatch = t => {
    const b = document.createElement('button'); b.className = 'swatch'; b.dataset.themeId = t.id; b.type = 'button';
    b.innerHTML = `<i style="border-radius:${t.r}"></i>${t.label}`;
    b.onclick = () => setTheme(t.id); return b;
  };
  const modeBtn = m => {
    const b = document.createElement('button'); b.className = 'swatch mode'; b.dataset.modeId = m.id; b.type = 'button';
    b.innerHTML = `<span>${m.ico}</span>${m.label}`;
    b.onclick = () => setMode(m.id); return b;
  };
  const layBtn = l => {
    const b = document.createElement('button'); b.className = 'swatch lay l-' + l.id; b.dataset.layoutId = l.id; b.type = 'button';
    b.innerHTML = `<i>${'<b></b>'.repeat(l.parts)}</i>${l.label}`;
    b.onclick = () => setLayout(l.id); return b;
  };
  build($('#themeGrid'), THEMES, swatch);
  build($('#modeGrid'), MODES, modeBtn);
  const mbtn = $('#modeBtn'); if (mbtn) mbtn.onclick = () => setMode(curMode() === 'light' ? 'dark' : 'light');
  build($('#layoutGrid'), LAYOUTS, layBtn);

  // quick theme picker in the top bar, so Settings isn't needed to change look
  const tBtn = $('#themeBtn'), tPop = $('#themePop');
  if (tBtn && tPop){
    build(tPop, THEMES, t => {
      const b = swatch(t), pick = b.onclick;
      b.onclick = () => { pick(); closePop(); };
      return b;
    });
    const closePop = () => { tPop.hidden = true; tBtn.setAttribute('aria-expanded', 'false'); };
    tBtn.onclick = e => {
      e.stopPropagation();
      tPop.hidden = !tPop.hidden;
      tBtn.setAttribute('aria-expanded', String(!tPop.hidden));
      mark();
    };
    document.addEventListener('click', e => { if (!tPop.hidden && !tPop.contains(e.target)) closePop(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !tPop.hidden) closePop(); });
  }
  mark(); dispatchEvent(new Event('atlas-theme'));

  // ── department rail: lights up when a team is briefed / finishes ──
  const DEPTS = [['research-strategy', 'Research & Strategy', '#4fe6f5'], ['design-content', 'Design & Content', '#a884ff'],
                 ['marketing', 'Marketing', '#ffb648'], ['business-operations', 'Business & Ops', '#3ee8a8'], ['finance', 'Finance', '#ff78aa']];
  const rail = $('#teamRail'), els = {}, timers = {}, teamDept = {};
  rail.innerHTML = '<div class="tr-title">Departments</div>';
  for (const [id, name, col] of DEPTS){
    const b = document.createElement('button'); b.className = 'tr-item'; b.style.setProperty('--c', col); b.type = 'button';
    b.innerHTML = `<span class="tr-dot"></span><span class="tr-name">${name}</span><span class="tr-state">idle</span>`;
    b.onclick = () => $('#navBrain') && $('#navBrain').click();
    rail.appendChild(b); els[id] = b; teamDept[id] = id;
  }
  fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json())
    .then(g => (g.nodes || []).forEach(n => { if (n.type === 'sub' || n.type === 'dept') teamDept[n.id] = n.group || n.id; }))
    .catch(() => {});
  const setState = (id, st) => {
    const b = els[id]; if (!b) return;
    b.classList.remove('working', 'done'); if (st) b.classList.add(st);
    b.querySelector('.tr-state').textContent = st === 'working' ? 'working…' : st === 'done' ? 'done' : 'idle';
  };
  const settle = id => { setState(id, 'done'); clearTimeout(timers[id]); timers[id] = setTimeout(() => setState(id, null), 5000); };
  const prevHandle = handle;
  handle = ev => {
    try {
      if (ev.t === 'tool' && ev.phase === 'use'){
        const m = /team\.py\s+(brief|remember|publish)\s+([a-z0-9-]+)/.exec(String(ev.input || ''));
        const d = m && teamDept[m[2]];
        if (d){ if (m[1] === 'brief'){ clearTimeout(timers[d]); setState(d, 'working'); } else settle(d); }
      } else if (ev.t === 'complete' || ev.t === 'error'){
        for (const id in els) if (els[id].classList.contains('working')) settle(id);
      }
    } catch (_) {}
    return prevHandle(ev);
  };
})();
