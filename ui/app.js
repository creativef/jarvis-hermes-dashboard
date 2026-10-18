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
  const pausedMic = pauseListening();      // typed while the mic is open: don't let him hear himself

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
  if (pausedMic) resumeListening();
}

function handle(ev){
  switch (ev.t){
    case 'status':
      log('status', 'STATUS',
        `core online · profile=${ev.profile||'default'} permission=${ev.permission||'normal'}`);
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
      speakDone = speakThisRun ? say(spoken) : Promise.resolve();
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
let micStream=null, recorder=null, actx=null, analyser=null, vdata=null;
let vad=null, spoke=false, loudAt=0, turnStart=0;
let floorSum=0, floorN=0, threshold=0.02, peak=0, calibrating=true;
const SILENCE=1200, MIN_TURN_MS=350, MAX_TURN_MS=60000, NO_SPEECH_MS=10000;

// ── voice out ──
// Everything Atlas says goes through say(), one line after another, so stopSpeech()
// can always silence him and empty the queue. speak() always finishes — on end,
// error, pause or stop — so the queue can never get stuck behind a paused line.
let muted = false, player = null, endSpeech = null;
let ttsChain = Promise.resolve(), synthChain = Promise.resolve(), speechEpoch = 0;

const forSpeech = text => {
  text = cleanForSpeech(text);
  return text.length > 700 ? text.slice(0, 680).replace(/\s+\S*$/,'') + '…' : text;
};
// Never rejects: a failed synthesis just resolves to null and that line is skipped.
const fetchAudio = text => fetch('/api/speak', {method:'POST',
    headers:apiHeaders({'content-type':'application/json'}), body: JSON.stringify({text})})
  .then(r => r.ok ? r.blob() : null).catch(() => null);

function say(text){
  const ep = speechEpoch, spoken = forSpeech(text);
  // Audio is made one line at a time, starting now, so line 2 is ready the moment
  // line 1 ends. Lines queued before a stopSpeech() are never synthesised.
  const audio = (RT.tts && spoken && !muted)
    ? (synthChain = synthChain.then(() => ep === speechEpoch ? fetchAudio(spoken) : null))
    : null;
  ttsChain = ttsChain.then(() => ep === speechEpoch ? speak(text, audio) : null).catch(() => {});
  return ttsChain;
}

function stopSpeech(){
  speechEpoch++;                                // anything still queued is dropped
  if (player){ try{ player.pause(); }catch(_){} }
  try{ speechSynth?.cancel(); }catch(_){}
  if (endSpeech) endSpeech();
}

// Pause an open listening turn so Atlas doesn't hear himself; resumeListening() re-opens it.
function pauseListening(){
  if (!convo || suppress) return false;
  suppress = true;
  if (recorder && recorder.state === 'recording'){ recorder._cancel = true; try{ recorder.stop(); }catch(_){} }
  if (recognition){ recognition.onend = null; try{ recognition.abort(); }catch(_){} recognition = null; }
  return true;
}
function resumeListening(){
  suppress = false;
  if (!convo) return;
  if (micStream) beginTurn(); else startBrowserRecognition();
}

function speak(text, audio){
  return new Promise(resolve => {
    const spoken = forSpeech(text);
    if (muted || !spoken) return resolve();
    const pausedMic = pauseListening();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (endSpeech === finish) endSpeech = null;
      document.body.classList.remove('speaking');
      if (pausedMic) resumeListening();
      resolve();
    };
    endSpeech = finish;
    if (!RT.tts && RT.browserTts && speechSynth){
      try{
        speechSynth.cancel();
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.95; u.pitch = 0.82; u.volume = 1;
        document.body.classList.add('speaking');
        u.onend = u.onerror = finish;
        speechSynth.speak(u);
      }catch(_){ finish(); }
      return;
    }
    if (!RT.tts) return finish();
    (audio || fetchAudio(spoken))
      .then(blob => {
        if (finished) return;                   // stopped while the audio was being made
        if (!blob) return finish();
        const url = URL.createObjectURL(blob);
        if (player) player.pause();
        player = new Audio(url);
        document.body.classList.add('speaking');
        const done = () => { URL.revokeObjectURL(url); finish(); };
        player.onended = player.onerror = player.onpause = done;
        return player.play();
      })
      .catch(finish);
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
  stopSpeech();
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
    suppress = true;                            // deaf while he thinks and speaks
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
  if (recorder && recorder.state === 'recording'){ recorder._cancel = true; try{ recorder.stop(); }catch(_){} }
  spoke = false; peak = 0;
  floorSum = 0; floorN = 0; calibrating = true; threshold = 0.02;
  // chunks belong to their recorder, so a late chunk can't leak into the next turn
  const rec = recorder = new MediaRecorder(micStream, pickMime()), parts = [];
  rec.ondataavailable = e => { if (e.data?.size) parts.push(e.data); };
  rec.onstop = () => ship(rec, parts);
  rec.start(250);                               // timeslice → data flows reliably
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

async function ship(rec, parts){
  if (rec._cancel) return;
  const blob = new Blob(parts, {type: rec.mimeType || 'audio/webm'});
  // no speech heard, too short, or too small — just listen again, don't ship ambient noise
  if (!spoke || blob.size < 1400 || performance.now()-turnStart < MIN_TURN_MS){
    if (convo && !suppress) beginTurn();
    return;
  }
  suppress = true;                              // deaf while transcribing, thinking and speaking
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
      suppress = false;
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
    stopSpeech();
    return;
  }
  if (document.body.classList.contains('speaking')){ stopSpeech(); return; }   // first Esc hushes him
  if (convo) stopConvo();
});
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  b.setAttribute('aria-label', muted ? 'Unmute Atlas' : 'Mute Atlas');
  if (muted) stopSpeech();
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
      say(`Mission complete. ${(d.result||'').slice(0,300)}`);
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
      listening:['LISTENING', '<kbd>Space</kbd> sends what you said · closes the mic when quiet'],
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
    // mid-sentence: Space means "I'm done" — send now instead of waiting for silence
    if (convo && spoke && !suppress && recorder && recorder.state === 'recording'){ endTurn('sent with Space'); return; }
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
      stopSpeech();
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
      return say(text);                         // honours mute / call mode (speak() no-ops when muted)
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
  const queue = [];
  const callOn = () => $('#callBtn').getAttribute('aria-pressed') === 'true';
  const voiceOK = () => !callOn() && !muted;

  const parse = t => NO.test(t) ? 'deny' : (YES.test(t) ? 'once' : null);   // any "no" wins

  const HIGH_RE = /(delet|remove|rm\s|rmdir|wipe|erase|format|overwrit|truncate|force|--hard|reset|sudo|chmod|chown|kill|pkill|shutdown|reboot|drop\s|send|email|mail|message|post|publish|push|deploy|purchase|buy|pay|transfer|charge|curl[^|]*\|\s*(ba)?sh|credential|secret|password|token|ssh|\.env)/i;
  const LOW_RE = /^\s*(ls|cat|head|tail|pwd|find|grep|rg|git\s+(status|log|diff|show|branch)|echo|which|whoami|date|uptime|wc|du|df|stat)\b/i;

  function assessRisk(ev){
    const blob = `${ev.description || ''} ${ev.command || ''}`.trim();
    const tier = ev.risk_tier || (ev.risk === 'high' || HIGH_RE.test(blob) ? 'high' : LOW_RE.test(ev.command || '') ? 'low' : 'medium');
    let reason = ev.reason || '';
    if (!reason){
      if (tier === 'high') reason = 'Destructive, external, or financial operation — spoken "yes" is disabled; confirm with keyboard or tap.';
      else if (tier === 'low') reason = 'Read-only inspection — does not modify files, send messages, or spend money.';
      else reason = 'Modifies local files or workspace state — safe to approve by voice or tap.';
    }
    return {tier, reason};
  }

  function render(ev){
    const {tier, reason} = assessRisk(ev);
    const high = tier === 'high' || ev.risk === 'high';
    ev.risk = high ? 'high' : 'normal';
    card.dataset.tier = tier;
    $('#apBadge').textContent = high ? 'NEEDS YOUR OK · KEYBOARD ONLY' : 'NEEDS YOUR OK';
    $('#apBadge').classList.toggle('high', high);
    const tierEl = $('#apTier');
    if (tierEl){
      tierEl.dataset.tier = tier;
      tierEl.textContent = tier === 'high' ? '● HIGH RISK' : tier === 'low' ? '○ LOW RISK · READ-ONLY' : '◐ MEDIUM RISK · CHANGES FILES';
    }
    const stackEl = $('#apStack');
    if (stackEl){
      const total = 1 + queue.length;
      stackEl.hidden = total <= 1;
      stackEl.textContent = `1 of ${total}`;
    }
    $('#apTitle').textContent = `Atlas wants to ${ev.description || 'run a command'}.`;
    const reasonEl = $('#apReason');
    if (reasonEl) reasonEl.textContent = reason;
    $('#apCmd').textContent = ev.command || '(no command text)';
    $('#apHint').textContent = high
      ? 'High-risk tier: spoken "yes" is disabled. Press Enter or click Approve once, or say "no" / press Esc to deny.'
      : (voiceOK() ? 'Say "yes" or "no", or use the buttons below.' : 'Use the buttons or the keyboard.');
    card.hidden = false;
  }

  function close(){
    cur = null; window.__approvalOpen = false;
    clearInterval(tick); tick = null; card.hidden = true;
    if (listening){ listening.cancel(); listening = null; }
    if (queue.length){
      const next = queue.shift();
      setTimeout(() => onApproval(next), 60);
    }
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
        if (ev.risk === 'high'){ await say('That one needs the keyboard. Press Enter to approve.'); return; }
        return answer('once', 'voice');
      }
      if (attempt === 0) await say("Sorry, yes or no?");
    }
  }

  async function onApproval(ev){
    if (cur){ queue.push(ev); render(cur); return; }
    cur = ev; shownAt = Date.now(); window.__approvalOpen = true;
    render(ev); log('command', 'APPROVAL', `asked [${card.dataset.tier || 'medium'}]: ${ev.description} — ${(ev.command || '').slice(0, 120)}`);
    setState('', 'AWAITING OK', ev.description.slice(0, 32));
    let left = TTL; $('#apTimer').textContent = `${left}s`;
    const ringEl = $('#apRing');
    const setRing = s => { if (ringEl) ringEl.style.strokeDashoffset = String((1 - Math.max(0, s) / TTL) * 56.55); };
    setRing(left);
    tick = setInterval(() => {
      left--; $('#apTimer').textContent = `${Math.max(left,0)}s`;
      setRing(left);
      if (left <= 0){ toast('No answer — denied'); answer('deny', 'timeout'); }
    }, 1000);
    if (voiceOK()){
      await say(`I need your approval for a ${ev.description}. The command is on screen. `
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

// ══════════ living orb: character states · radial waveform · comet/ring · particles · live caption ══════════
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

  // ── input levels & live caption ──
  let micLvl = 0;                                   // fed by the existing mic meter
  const prevMeter = window.meter;
  if (typeof prevMeter === 'function') window.meter = rms => { micLvl = Math.min(1, rms * 7); return prevMeter(rms); };

  let outCtx = null, outAn = null, outData = null, wired = null;
  function outLevel(){                              // real loudness of Atlas's voice
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

  // ── orb visualizer style (orb | waveform | ring) ──
  let orbStyle = 'orb';
  try { const sv = localStorage.getItem('jarvis.orbStyle'); if (/^(orb|waveform|ring)$/.test(sv || '')) orbStyle = sv; } catch (_) {}
  window.AtlasOrb = {
    getStyle: () => orbStyle,
    setStyle(st){
      if (!/^(orb|waveform|ring)$/.test(st)) return;
      orbStyle = st;
      try { localStorage.setItem('jarvis.orbStyle', st); } catch (_) {}
      document.documentElement.dataset.orbStyle = st;
      document.querySelectorAll('[data-orb-style]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.orbStyle === st)));
    },
    flash(kind){
      ringFlash = {kind: kind || 'done', born: performance.now()};
    },
    bargeIn(){
      bargeUntil = performance.now() + 450;
    },
    setCaption(text, confirmed = false, kind = 'VOICE'){
      const box = document.getElementById('orbCaption');
      const kEl = document.getElementById('ocKind'), tEl = document.getElementById('ocText');
      if (!box || !tEl) return;
      clearTimeout(capTimer);
      if (!text){ box.hidden = true; return; }
      box.hidden = false;
      box.classList.toggle('confirmed', !!confirmed);
      if (kEl) kEl.textContent = kind;
      tEl.textContent = text;
      capTimer = setTimeout(() => { box.hidden = true; }, confirmed ? 4200 : 8000);
    },
    setTool(label){
      const el = document.getElementById('stTool');
      if (!el) return;
      if (!label){ el.hidden = true; el.textContent = ''; }
      else { el.hidden = false; el.textContent = label; }
    }
  };
  document.documentElement.dataset.orbStyle = orbStyle;

  let capTimer = null, ringFlash = null, bargeUntil = 0, wakingUntil = 0, doneSweepAt = 0, errShakeAt = 0;
  let prevState = 'idle', prevMicOpen = false;

  // Watch #strun for browser speech partial/final transcripts and tool usage
  const strunEl = document.getElementById('strun');
  if (strunEl){
    new MutationObserver(() => {
      const txt = strunEl.textContent || '';
      if (txt.startsWith('HEARD: ')){
        const phrase = txt.slice(7).trim();
        if (phrase) window.AtlasOrb.setCaption(phrase, false, 'HEARING');
      } else if (txt === 'TRANSCRIBING' || txt === '…'){
        window.AtlasOrb.setCaption('Transcribing speech…', false, 'VOICE');
      }
    }).observe(strunEl, {childList: true, characterData: true, subtree: true});
  }

  // Hook into handle() to surface tool badges under orb and done/error flashes
  const origHandleOrb = handle;
  handle = ev => {
    try {
      if (ev.t === 'tool'){
        if (ev.phase === 'use'){
          const raw = String(ev.name || 'tool').toLowerCase();
          const friendly = /browser|chrome|web/.test(raw) ? 'browser'
                         : /read|write|patch|file|search/.test(raw) ? 'files'
                         : /search|extract/.test(raw) ? 'search'
                         : /terminal|exec|bash/.test(raw) ? 'terminal'
                         : raw.slice(0, 16);
          window.AtlasOrb.setTool(`▸ ${friendly}`);
        } else {
          window.AtlasOrb.setTool('');
        }
      } else if (ev.t === 'delta' && !firstDelta){
        window.AtlasOrb.setTool('');
      } else if (ev.t === 'complete'){
        window.AtlasOrb.setTool('');
        doneSweepAt = performance.now();
        window.AtlasOrb.flash('done');
      } else if (ev.t === 'error'){
        window.AtlasOrb.setTool('');
        errShakeAt = performance.now();
        window.AtlasOrb.flash('error');
      }
    } catch (_) {}
    return origHandleOrb(ev);
  };

  // Watch action log for transcribed voice confirmation or barge-in
  const logEl = document.getElementById('log');
  if (logEl){
    new MutationObserver(muts => {
      for (const m of muts){
        for (const n of m.addedNodes){
          if (!(n instanceof HTMLElement)) continue;
          const msg = n.querySelector('.msg')?.textContent || '';
          const tm = /transcribed(?: by Parakeet in \d+ms)?:\s*"([^"]+)"/i.exec(msg);
          if (tm) window.AtlasOrb.setCaption(tm[1], true, 'CONFIRMED');
        }
      }
    }).observe(logEl, {childList: true});
  }

  // ── particles (36 orbital motes) ──
  const PARTS = Array.from({length: 36}, (_, i) => ({
    a: (i / 36) * Math.PI * 2,
    dist: 0.24 + (i % 7) * 0.032,
    spd: (i % 2 ? 1 : -1) * (0.18 + (i % 5) * 0.05),
    sz: 1.2 + (i % 3) * 0.65,
    ph: i * 1.1
  }));

  // ── look per state ──
  const LOOK = {
    idle:      {c:[79,170,245],  glow:.35, r:.19},
    waking:    {c:[110,245,255], glow:.78, r:.18},
    listening: {c:[79,235,230],  glow:.68, r:.20},
    speaking:  {c:[168,132,255], glow:.78, r:.20},
    thinking:  {c:[255,182,72],  glow:.58, r:.19},
    waiting:   {c:[255,182,72],  glow:.72, r:.195},
    error:     {c:[255,107,120], glow:.65, r:.19},
    done:      {c:[62,232,168],  glow:.62, r:.195},
    call:      {c:[130,115,175], glow:.18, r:.175},
  };
  const cur = {c:[79,170,245], glow:.35, r:.19, lvl:0, spin:0};
  const rgbVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim().split(',').map(Number);
  const readLook = () => {
    const src = {idle:'--orb-idle', listening:'--orb-listen', speaking:'--orb-speak', thinking:'--orb-think'};
    for (const k in src){ const v = rgbVar(src[k]); if (v.length === 3 && v.every(Number.isFinite)) LOOK[k].c = v; }
    LOOK.waiting.c = LOOK.thinking.c.slice();
    const st = document.querySelector('.stage');
    const sc = parseFloat(st && getComputedStyle(st).getPropertyValue('--orb-scale'));
    orbScale = Number.isFinite(sc) && sc > 0 ? sc : 1;
  };
  let orbScale = 1;
  readLook(); cur.c = LOOK.idle.c.slice();
  addEventListener('atlas-theme', readLook);
  const mix = (a, b, k) => a + (b - a) * k;
  const ripples = []; let lastRip = 0;
  let t0 = performance.now();

  function resolveState(now){
    const cl = document.body.classList;
    const callOn = document.getElementById('callBtn')?.getAttribute('aria-pressed') === 'true'
                || document.getElementById('micbar')?.dataset.state === 'call';
    const micOpen = cl.contains('micopen');
    if (micOpen && !prevMicOpen){
      wakingUntil = now + 650;
      ripples.push({born: now, dir: -1, a: 0.65});
    }
    prevMicOpen = micOpen;
    if (cl.contains('speaking') && micLvl > 0.25) bargeUntil = now + 420;

    let st = 'idle';
    if (callOn) st = 'call';
    else if (window.__approvalOpen || document.getElementById('micbar')?.dataset.state === 'ask') st = 'waiting';
    else if (cl.contains('error')) st = 'error';
    else if (cl.contains('speaking')) st = 'speaking';
    else if (now < wakingUntil) st = 'waking';
    else if (cl.contains('listening')) st = 'listening';
    else if (cl.contains('running')) st = 'thinking';
    else if (cl.contains('done')) st = 'done';

    document.body.classList.toggle('waiting', st === 'waiting');
    document.body.classList.toggle('callmode', st === 'call');
    if (st !== prevState){
      if (st === 'done') doneSweepAt = now;
      if (st === 'error') errShakeAt = now;
      prevState = st;
    }
    return st;
  }

  const brainOv = document.getElementById('brainOverlay');
  function frame(now){
    requestAnimationFrame(frame);
    if (document.hidden || !W || (brainOv && !brainOv.hidden)) return;   // nothing to see under the Brain
    const t = (now - t0) / 1000;
    const state = resolveState(now);
    const L = LOOK[state] || LOOK.idle;

    // target level for this state
    let target = 0;
    if (state === 'speaking'){
      const o = outLevel();
      target = o != null ? o : 0.38 + 0.26 * Math.sin(t * 9) * Math.sin(t * 3.1) + 0.14 * Math.sin(t * 17);
    } else if (state === 'listening'){
      target = Math.max(micLvl, 0.08 + 0.05 * Math.sin(t * 4.2));
    } else if (state === 'thinking'){
      target = 0.04;                                // surface goes still in thinking
    } else if (state === 'waiting'){
      const hb = Math.pow(Math.max(0, Math.sin(t * 2.7)), 3);
      target = hb * 0.38;
    } else if (state === 'waking'){
      target = 0.32;
    }
    micLvl *= 0.9;
    const k = target > cur.lvl ? 0.35 : 0.08;
    cur.lvl = mix(cur.lvl, Math.max(0, target), k);
    for (let i = 0; i < 3; i++) cur.c[i] = mix(cur.c[i], L.c[i], 0.08);
    cur.glow = mix(cur.glow, L.glow, 0.08); cur.r = mix(cur.r, L.r, 0.08);
    cur.spin += (state === 'thinking' ? 1.35 : state === 'listening' ? 0.35 : 0.14) / 60;

    const S = Math.min(W, H);
    let cx = W / 2, cy = H / 2;
    // error brief horizontal shake
    if (now - errShakeAt < 420 && !reduce){
      const decay = 1 - (now - errShakeAt) / 420;
      cx += Math.sin((now - errShakeAt) * 0.09) * 9 * decay;
    }
    // slow 4s breathing in idle
    const breathe = reduce ? 0 : (state === 'thinking' ? 0 : Math.sin(t * (Math.PI / 2)) * 0.028);
    let R = S * cur.r * orbScale * (1 + breathe);
    if (state === 'waking') R *= 0.94;              // rings tighten ~6% on wake
    else if (state === 'listening') R *= 1 - cur.lvl * 0.12;
    else if (state === 'speaking') R *= 1 + cur.lvl * 0.15;
    else if (state === 'waiting') R *= 1 + cur.lvl * 0.10;
    if (now < bargeUntil) R *= 0.86;                // barge-in catch & shrink

    const [r, g, b] = cur.c.map(Math.round), col = a => `rgba(${r},${g},${b},${a})`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // ── Waveform bar mode (suits wall display or minimalists) ──
    if (orbStyle === 'waveform'){
      const bars = 32, bw = Math.min(W * 0.72, 360), bh = S * 0.28, x0 = cx - bw / 2;
      const gr = ctx.createRadialGradient(cx, cy, 10, cx, cy, S * 0.45);
      gr.addColorStop(0, col(0.22 * cur.glow)); gr.addColorStop(1, col(0));
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < bars; i++){
        const u = i / (bars - 1) - 0.5;
        const env = Math.cos(u * Math.PI);
        const wave = Math.abs(Math.sin(t * (state === 'speaking' ? 8 : 3.2) + i * 0.45));
        const h = Math.max(4, env * bh * (0.14 + cur.lvl * 0.85 * wave + (state === 'thinking' ? 0.18 * Math.sin(t * 5 + i * 0.3) : 0)));
        const x = x0 + i * (bw / bars);
        ctx.fillStyle = col(0.45 + env * 0.45);
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, cy - h / 2, (bw / bars) * 0.64, h, 3) : ctx.rect(x, cy - h / 2, (bw / bars) * 0.64, h);
        ctx.fill();
      }
      return;
    }

    // soft outer glow
    const gr = ctx.createRadialGradient(cx, cy, R * 0.35, cx, cy, S * 0.5);
    gr.addColorStop(0, col(0.30 * cur.glow + cur.lvl * 0.25));
    gr.addColorStop(0.48, col(0.10 * cur.glow));
    gr.addColorStop(1, col(0));
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);

    // ── Outer drifting ticks & signature Atlas ring ──
    const ringR = R * (state === 'waking' ? 1.24 : 1.32);
    ctx.save();
    ctx.translate(cx, cy);
    const tickCount = 60;
    const tickDrift = t * (state === 'thinking' ? 0.35 : 0.06);
    for (let i = 0; i < tickCount; i++){
      const a = (i / tickCount) * Math.PI * 2 + tickDrift;
      const maj = i % 5 === 0;
      const r0 = ringR + (maj ? 8 : 11);
      const r1 = ringR + (maj ? 16 : 14) + (state === 'listening' ? Math.sin(a * 6 + t * 8) * cur.lvl * 7 : 0);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.strokeStyle = col(maj ? 0.42 : 0.18);
      ctx.lineWidth = maj ? 1.6 : 1;
      ctx.stroke();
    }

    // State-specific outer rings
    if (state === 'thinking'){
      // Segmented ring + orbiting comet chasing around
      ctx.strokeStyle = col(0.32);
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 10]);
      ctx.beginPath(); ctx.arc(0, 0, ringR, t * 1.2, t * 1.2 + Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // Orbiting comet arc + bright head
      const ca = t * 2.8;
      const grad = ctx.createConicGradient ? null : null;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, ca - 1.3, ca);
      ctx.strokeStyle = col(0.88);
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.stroke();
      const hx = Math.cos(ca) * ringR, hy = Math.sin(ca) * ringR;
      ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.shadowColor = col(1); ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
    } else if (state === 'waiting'){
      // Slow amber heartbeat with one ring held open (gap at top)
      const pulse = 1 + 0.035 * Math.sin(t * 2.7);
      ctx.beginPath();
      ctx.arc(0, 0, ringR * pulse, -Math.PI * 0.32, Math.PI * 1.32);
      ctx.strokeStyle = 'rgba(255,182,72,0.88)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (state === 'listening'){
      // Radial waveform ring deformed by real mic level
      const segs = 72;
      ctx.beginPath();
      for (let i = 0; i <= segs; i++){
        const a = (i / segs) * Math.PI * 2;
        const wave = Math.sin(a * 8 + t * 10) * 0.5 + Math.cos(a * 13 - t * 7) * 0.5;
        const rr = ringR + wave * (3 + cur.lvl * 18);
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = col(0.62);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();

    // ── Done green ring sweep / Error red flash ──
    if (now - doneSweepAt < 900){
      const p = (now - doneSweepAt) / 900;
      ctx.save(); ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.arc(0, 0, ringR * (1 + p * 0.08), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, p * 1.25));
      ctx.strokeStyle = `rgba(62,232,168,${(1 - p) * 0.95})`;
      ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.stroke();
      ctx.restore();
    }
    if (ringFlash){
      const age = (now - ringFlash.born) / 480;
      if (age >= 1) ringFlash = null;
      else {
        const fc = ringFlash.kind === 'error' ? '255,107,120' : '62,232,168';
        ctx.beginPath(); ctx.arc(cx, cy, ringR * (1 + age * 0.14), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${fc},${(1 - age) * 0.85})`;
        ctx.lineWidth = 3; ctx.stroke();
      }
    }

    // ── Faint particles (orbit in idle, drift inward on listening, push outward on speaking) ──
    if (!reduce && state !== 'call'){
      for (const p of PARTS){
        p.a += (p.spd * (state === 'thinking' ? 1.8 : 0.7)) / 60;
        if (state === 'listening'){
          p.dist -= (0.04 + cur.lvl * 0.12) / 60;
          if (p.dist < 0.16) p.dist = 0.44;
        } else if (state === 'speaking'){
          p.dist += (0.05 + cur.lvl * 0.22) / 60;
          if (p.dist > 0.46) p.dist = 0.18;
        } else {
          const home = 0.25 + (p.ph % 5) * 0.035;
          p.dist = mix(p.dist, home, 0.03);
        }
        const pr = S * p.dist * orbScale;
        const px = cx + Math.cos(p.a) * pr, py = cy + Math.sin(p.a) * pr;
        ctx.beginPath(); ctx.arc(px, py, p.sz, 0, Math.PI * 2);
        ctx.fillStyle = col(state === 'speaking' ? 0.65 : state === 'listening' ? 0.55 : 0.28);
        ctx.fill();
      }
    }

    // ripples: your voice sends rings inward, Atlas sends them outward
    if (!reduce && (state === 'speaking' || state === 'listening') && cur.lvl > 0.10 && now - lastRip > 250 - cur.lvl * 120){
      ripples.push({born: now, dir: state === 'speaking' ? 1 : -1, a: 0.22 + cur.lvl * 0.4}); lastRip = now;
    }
    for (let i = ripples.length - 1; i >= 0; i--){
      const p = ripples[i], age = (now - p.born) / 1400;
      if (age >= 1){ ripples.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - age, 2);
      const rr = p.dir > 0 ? mix(R * 1.05, S * 0.48, e) : mix(S * 0.48, R * 1.05, e);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = col(p.a * (1 - age)); ctx.lineWidth = 1.5; ctx.stroke();
    }

    // ── Ring-only mode stops after drawing the rings and particles ──
    if (orbStyle === 'ring'){
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = col(0.85); ctx.lineWidth = 2.5; ctx.stroke();
      return;
    }

    // ── The orb body ──
    const N = 96;
    // Thinking surface goes still; listening has high-harmonic radial waveform; speaking has word-rhythm pulses
    const amp = reduce || state === 'thinking' || state === 'call' ? 0.004
              : (state === 'speaking' ? 0.11 : state === 'listening' ? 0.065 : state === 'waiting' ? 0.025 : 0.012) * (0.3 + cur.lvl * 2.2);
    ctx.beginPath();
    for (let i = 0; i <= N; i++){
      const a = (i / N) * Math.PI * 2;
      const wob = state === 'listening'
        ? Math.sin(a * 6 + t * 7) * 0.45 + Math.sin(a * 12 - t * 11) * 0.35 + Math.cos(a * 18 + t * 15) * 0.2
        : Math.sin(a * 3 + t * 2.1 + cur.spin * 6) * 0.5
          + Math.sin(a * 5 - t * 3.3) * 0.3
          + Math.sin(a * 9 + t * (state === 'speaking' ? 14 : 5)) * 0.2 * (0.4 + cur.lvl * 2);
      const rad = R * (1 + wob * amp * 2.2);
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    const body = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R * 1.15);
    body.addColorStop(0, `rgba(255,255,255,${state === 'call' ? 0.45 : 0.85})`);
    body.addColorStop(0.35, col(state === 'call' ? 0.55 : 0.95));
    body.addColorStop(1, `rgba(${Math.round(r * 0.18)},${Math.round(g * 0.18)},${Math.round(b * 0.28)},${state === 'call' ? 0.7 : 0.95})`);
    ctx.shadowColor = col(0.8); ctx.shadowBlur = (state === 'call' ? 10 : 28) + cur.lvl * 50;
    ctx.fillStyle = body; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(234,246,250,.55)'; ctx.stroke();

    // ── Call mode lock glyph drawn cleanly above the orb label ──
    if (state === 'call'){
      ctx.save();
      ctx.translate(cx, cy - R * 0.42);
      ctx.strokeStyle = 'rgba(234,246,250,0.85)';
      ctx.fillStyle = 'rgba(234,246,250,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, -5, 6, Math.PI, 0); ctx.stroke();
      ctx.fillRect(-8, -5, 16, 12);
      ctx.restore();
    }
  }
  requestAnimationFrame(frame);
})();

/* ── pure interaction math for the Atlas Brain graph ─────────────────────────
   DOM-free helpers for picking (with a generous hit radius), the click/drag
   movement threshold, and the drawn hit radius. Exported on
   window.AtlasGraphMath and delimited by the @graph-math markers so the test in
   tests/test_brain_graph_ui.py can drive the real shipped logic through Node. */
/* @graph-math:start */
(() => {
  'use strict';
  const G = {
    HIT_PAD: 12,                    // extra *screen* px of clickable margin around every node (generous, zoom-consistent)
    DRAG_THRESHOLD: 4,              // CSS px the pointer may drift before it counts as a drag
    pickRadius: (r, k) => r + G.HIT_PAD / (k || 1),
    moved: (a, b, th) => Math.hypot(b.x - a.x, b.y - a.y) > (th == null ? G.DRAG_THRESHOLD : th),
    ZOOM_MIN: .35, ZOOM_MAX: 3,
    // Zoom in proportion to the scroll size (a trackpad pinch sends many tiny deltas, a mouse
    // notch one big one), keeping the world point under (px, py) fixed on screen.
    zoomAt: (view, deltaY, px, py, W, H) => {
      const d = Math.max(-50, Math.min(50, deltaY));
      const k = Math.max(G.ZOOM_MIN, Math.min(G.ZOOM_MAX, view.k * Math.exp(-d * 0.01)));
      const wx = (px - W / 2 - view.x) / view.k, wy = (py - H / 2 - view.y) / view.k;
      return {x: px - W / 2 - wx * k, y: py - H / 2 - wy * k, k};
    },
    // nodes: [{x,y,type,…}]; world: {x,y} of the pointer; visible(n); radiusOf(type).
    // Nearest centre wins; on a tie the last-drawn (visually front) node wins, so a
    // click on overlapping nodes lands on the one you can actually see.
    pick: (nodes, world, k, visible, radiusOf) => {
      let best = null, bd = Infinity;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (visible && !visible(n)) continue;
        const r = G.pickRadius(radiusOf ? radiusOf(n.type) : 4.5, k);
        const d = Math.hypot(n.x - world.x, n.y - world.y);
        if (d < r && d < bd) { best = n; bd = d; }
      }
      return best;
    },
  };
  if (typeof window !== 'undefined') window.AtlasGraphMath = G;
})();
/* @graph-math:end */

// ══════════ second brain: force-directed graph of the Atlas notes ══════════
(() => {
  const ov = document.getElementById('brainOverlay'); if (!ov) return;
  const cv = document.getElementById('brainCanvas'), ctx = cv.getContext('2d');
  const $b = id => document.getElementById(id);
  const GM = window.AtlasGraphMath;
  const GROUP = {};                                   // dept slug -> [r,g,b], resolved from theme variables
  const RADIUS = {hub:16, dept:11, sub:6.5, inbox:6.5, notebook:3.5, commons:6, log:4, other:4};
  const INBOX_GROUP = '__inbox';                      // synthetic group key so the inbox cluster reads as a cluster
  // Depth layering: 0 = nearest the viewer (biggest, brightest, most shadow), higher = pushed back.
  // hub → dept → inbox/commons cluster → sub → notebook/log strays. Drives size, shade and ambient shadow.
  const LAYER = {hub:0, dept:1, inbox:2, commons:2, sub:3, log:4, notebook:4, other:4};
  const LAYER_N = 5;
  const layerOf = n => (LAYER[n.type] == null ? 3 : LAYER[n.type]);
  const colorOf = n => n.type === 'hub' ? HUB : n.type === 'inbox' ? INBOX : (GROUP[n.group] || NEUTRAL);
  let INK = '234,246,250', HUB = [240,250,255], INBOX = [79,230,245], NEUTRAL = [130,160,180], FONT = 'system-ui, sans-serif', LIGHT = false;
  let ACCENT = '79,230,245', BG = '5,11,18', SH = '0,0,0', AMBER = [255,190,92], GREEN = [62,232,168];
  const probe = document.createElement('i'); probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  ov.appendChild(probe);
  const rgbOf = (css, dflt) => {                      // any CSS colour/var -> [r,g,b]
    probe.style.color = ''; probe.style.color = css;
    const m = getComputedStyle(probe).color.match(/[\d.]+/g);
    if (!m || m.length < 3) return dflt;
    const v = /srgb/.test(getComputedStyle(probe).color) ? m.slice(0, 3).map(x => Math.round(x * 255)) : m.slice(0, 3).map(Math.round);
    return v.every(Number.isFinite) ? v : dflt;
  };
  const deptList = () => (window.AtlasData ? AtlasData.depts : []);
  const readTheme = () => {
    const cs = getComputedStyle(document.documentElement);
    INK = cs.getPropertyValue('--ink-rgb').trim() || INK;
    ACCENT = cs.getPropertyValue('--accent-rgb').trim() || ACCENT;   // gradient tint
    BG = cs.getPropertyValue('--bg-rgb').trim() || BG;               // gradient base = theme background
    SH = cs.getPropertyValue('--shadow-rgb').trim() || SH;           // vignette + ambient node shadow
    const h = cs.getPropertyValue('--hub-rgb').trim().split(',').map(Number);
    if (h.length === 3 && h.every(Number.isFinite)) HUB = h;
    NEUTRAL = rgbOf('var(--dim)', NEUTRAL);
    INBOX = rgbOf('var(--inbox-rgb)', INBOX);
    AMBER = rgbOf('var(--amber)', AMBER); GREEN = rgbOf('var(--green)', GREEN);
    LIGHT = document.documentElement.dataset.mode === 'light';
    FONT = getComputedStyle(document.body).fontFamily || FONT;
    for (const d of deptList()) GROUP[d.slug] = rgbOf(`var(${AtlasData.colorVar(d.slug)})`, NEUTRAL);
    if (!ov.hidden && W) draw();                      // repaint straight away on a theme/mode switch
  };
  const legend = () => {
    const hasInbox = nodes.some(n => n.type === 'inbox');
    $b('brLegend').innerHTML = deptList().map(d =>
      `<button type="button" class="lg-dept${collapsed.has(d.slug) ? ' off' : ''}" data-fold="${d.slug}" aria-pressed="${collapsed.has(d.slug)}" title="Fold or unfold this department"><i style="background:var(${AtlasData.colorVar(d.slug)})"></i>${d.name.replace(/&/g, '&amp;')}</button>`).join('')
      + (hasInbox ? '<span class="lg-inbox"><i></i>Inbox</span>' : '')
      + (nodes.some(n => n.type === 'other') ? '<span><i style="background:var(--dim)"></i>Other notes</span>' : '')
      + '<span><i style="background:rgb(var(--hub-rgb))"></i>Atlas hub</span><span class="lg-hint" title="Drag a node to pin it, double-click to unpin. Click a department to fold it. Scroll to pan, pinch or ⌘+scroll to zoom.">⇧-drag to link · arrows hop · <kbd>X</kbd> isolate · <kbd>L</kbd> timeline · <kbd>E</kbd> edit · <kbd>N</kbd> new · <kbd>F</kbd> fit</span>';
  };
  let nodes = [], links = [], byId = new Map(), adj = new Map();
  const PIN_KEY = 'atlas.brain.pins';
  let pins = {};
  try { pins = JSON.parse(localStorage.getItem(PIN_KEY) || '{}') || {}; } catch (_) {}
  const savePins = () => { try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); } catch (_) {} };
  // What is on stage beyond the type toggles: folded departments · isolate (a note + neighbours) · timeline cursor.
  const FOLD_KEY = 'atlas.brain.folded', collapsed = new Set();
  try { for (const s of JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) collapsed.add(s); } catch (_) {}
  let iso = null, isoSet = null;                       // {id, depth} and the ids it keeps on stage
  const tl = {on: false, t: 0, t0: 0, t1: 0, playing: false, last: 0};   // timeline cursor (epoch seconds)
  const WEEK = 7 * 86400;
  const fresh = n => tl.on && n.born > tl.t - WEEK && n.born <= tl.t;  // born in the week before the cursor
  const touched = new Map();                           // id → {at, kind}: notes Atlas read or wrote recently
  let linkDrag = null;                                 // ⇧-drag from one node to another adds a [[link]]
  const mini = $b('brMini'), mctx = mini ? mini.getContext('2d') : null;
  let miniT = null;                                    // world → minimap transform, kept for clicks
  let W = 0, H = 0, dpr = 1, raf = 0, alpha = 1;
  let view = {x:0, y:0, k:1}, hover = null, selected = null, drag = null, pan = null, moved = false;
  let searchQuery = '', searchMatches = [], searchIdx = 0, flyAnim = null, viewSaved = null;
  let downX = 0, downY = 0, downId = null, lastPX = null, lastPY = null, pointerIn = false;
  const edgePulses = [], nodeSparks = new Map();
  // Depth & life: breathing, a staggered fade-in, and an idle animation loop.
  let lastDraw = 0, revealT0 = 0, revealTotal = 0;     // fade-in stagger bookkeeping
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
  let REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (window.matchMedia){
    const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onRm = () => { REDUCE = rmq.matches; if (!ov.hidden && !raf) loop(); else draw(); };
    if (rmq.addEventListener) rmq.addEventListener('change', onRm);
    else if (rmq.addListener) rmq.addListener(onRm);
  }
  readTheme(); legend();
  addEventListener('atlas-theme', readTheme);
  if (window.AtlasData) AtlasData.onChange(() => { readTheme(); legend(); if (!ov.hidden) load(); });

  const fit = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
    if (!ov.hidden && W) draw();                      // setting .width/.height clears the bitmap: repaint at once
  };
  new ResizeObserver(fit).observe(cv);
  // Re-fit when the display's pixel ratio changes (e.g. the window moves to a monitor
  // with a different scale factor), so the bitmap is never left at the old resolution.
  let dprMq = null;
  const watchDpr = () => {
    if (!window.matchMedia) return;
    if (dprMq && dprMq.removeEventListener) dprMq.removeEventListener('change', watchDpr);
    dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (dprMq.addEventListener) dprMq.addEventListener('change', watchDpr);
    fit();
  };
  watchDpr();

  const showNb = () => $b('brNotebooks').checked, showSh = () => $b('brShared').checked;
  const typeOn = n => n.type === 'notebook' ? showNb() : (n.type === 'commons' || n.type === 'log') ? showSh() : true;
  const visible = n => typeOn(n)
    && !(n.type !== 'dept' && n.group && collapsed.has(n.group))
    && (!isoSet || isoSet.has(n.id))
    && (!tl.on || !n.born || n.born <= tl.t);

  function pulseNode(nodeId, kind = 'read'){
    const n = byId.get(nodeId);
    if (!n) return;
    const now = performance.now();
    nodeSparks.set(n.id, now);
    for (const l of links){
      if (l.a.id === n.id || l.b.id === n.id){
        const from = l.a.id === n.id ? l.a : l.b;
        const to = l.a.id === n.id ? l.b : l.a;
        edgePulses.push({from, to, born: now, dur: 950, kind});
      }
    }
    if (!ov.hidden && !raf) loop();
  }

  function flyTo(n, zoom = 1.25){
    if (!n) return;
    if (!visible(n)){                                 // bring it on stage whatever is hiding it
      if (n.type === 'notebook') $b('brNotebooks').checked = true;
      else if (n.type === 'commons' || n.type === 'log') $b('brShared').checked = true;
      if (n.group && n.type !== 'dept' && collapsed.has(n.group)) toggleFold(n.group);
      if (isoSet && !isoSet.has(n.id)) setIsolate(null, 1, false);
      if (tl.on && n.born > tl.t){ tl.t = tl.t1; tlSync(); }
    }
    const tk = Math.max(view.k, zoom);
    flyAnim = {
      t0: performance.now(), dur: 380,
      x0: view.x, y0: view.y, k0: view.k,
      x1: -n.x * tk, y1: -n.y * tk, k1: tk,
    };
    pulseNode(n.id, 'focus');
    if (!ov.hidden && !raf) loop();
  }

  function renderOutline(){
    const box = $b('brOutline'); if (!box || box.hidden) return;
    const groups = new Map();
    const matchSet = new Set(searchMatches.map(m => m.id));
    for (const n of nodes){
      if (!visible(n)) continue;
      const g = n.group || n.type || 'other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    }
    let html = '';
    for (const [g, list] of groups){
      html += `<div class="bo-group"><h4>${esc(g.replace(/-/g, ' '))} (${list.length})</h4><div class="bo-items">`
        + list.map(n => `<button type="button" class="bo-btn${matchSet.has(n.id) ? ' match' : ''}" data-node="${esc(n.id)}">${esc(n.id)}</button>`).join('')
        + `</div></div>`;
    }
    box.innerHTML = html || '<div class="pal-empty">No visible nodes.</div>';
  }

  async function load(){
    try {
      const g = await fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json());
      if (!g.nodes) throw 0;
      const old = new Map(nodes.map(n => [n.id, n]));
      const now = performance.now();
      nodes = g.nodes.map((n, i) => {
        const o = old.get(n.id), a = (i / g.nodes.length) * Math.PI * 2, p = pins[n.id];
        if (!o && old.size > 0) nodeSparks.set(n.id, now);
        return Object.assign(n, {x: p ? p[0] : o ? o.x : Math.cos(a) * 220 + Math.random() * 20,
                                 y: p ? p[1] : o ? o.y : Math.sin(a) * 220 + Math.random() * 20, vx: 0, vy: 0, pinned: !!p});
      });
      byId = new Map(nodes.map(n => [n.id, n]));
      // Re-point live references at the freshly built objects (ids survive a reload),
      // instead of leaving them holding the previous node objects.
      const reRef = o => (o ? byId.get(o.id) || null : null);
      selected = reRef(selected); hover = reRef(hover); drag = reRef(drag);
      if (searchMatches.length) searchMatches = searchMatches.map(reRef).filter(Boolean);
      links = g.links.map(l => ({a: byId.get(l.source), b: byId.get(l.target)})).filter(l => l.a && l.b);
      adj = new Map(nodes.map(n => [n.id, new Set()]));
      links.forEach(l => { adj.get(l.a.id).add(l.b.id); adj.get(l.b.id).add(l.a.id); });
      // Anchor any note that links to nothing (e.g. a big inbox source file) to the hub —
      // inbox notes to the inbox hub — so a stray note cannot drift off to the edge and
      // sit there as an unfindable speck.
      const hub = byId.get('Atlas') || nodes.find(n => n.type === 'hub');
      const inboxHub = nodes.find(n => n.type === 'inbox' && n.id === 'inbox');
      for (const n of nodes){
        if (adj.get(n.id).size) continue;
        const a = (n.type === 'inbox' && inboxHub && inboxHub !== n) ? inboxHub : hub;
        if (!a || a === n) continue;
        links.push({a: n, b: a, anchor: true});
        adj.get(n.id).add(a.id); adj.get(a.id).add(n.id);
      }
      alpha = 1;
      for (let i = 0; i < 320; i++) step();     // open already settled, not mid-scramble
      alpha = .05;
      revealT0 = performance.now(); revealTotal = nodes.length;   // fade-in stagger for the fresh layout
      if (!g.exists) $b('brTitle').textContent = 'No brain folder found at ' + g.root;
      legend(); renderOutline();
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
      if (a === drag || a.pinned){ a.vx = a.vy = 0; continue; }
      a.vx *= 0.82; a.vy *= 0.82; a.x += a.vx; a.y += a.vy;
    }
    alpha = Math.max(0.02, alpha * 0.985);
    let mx = 0, my = 0;                                   // keep the whole graph centred on the canvas
    for (const a of vis){ mx += a.x; my += a.y; }
    if (n){ mx /= n; my /= n; for (const a of vis){ if (a === drag || a.pinned) continue; a.x -= mx * 0.2; a.y -= my * 0.2; } }
  }

  function fitTo(list, animate){                          // frame these nodes with a margin
    if (!list.length || !W) return;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const a of list){ x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); y0 = Math.min(y0, a.y); y1 = Math.max(y1, a.y); }
    const k = Math.max(.45, Math.min(1.5, Math.min((W - 140) / Math.max(1, x1 - x0), (H - 110) / Math.max(1, y1 - y0))));
    const x = -((x0 + x1) / 2) * k, y = -((y0 + y1) / 2) * k;
    if (animate && !REDUCE){ flyAnim = {t0: performance.now(), dur: 420, x0: view.x, y0: view.y, k0: view.k, x1: x, y1: y, k1: k}; if (!raf && !ov.hidden) loop(); }
    else { view.x = x; view.y = y; view.k = k; draw(); }
  }
  const fitView = () => fitTo(nodes.filter(visible), false);

  const radiusOf = t => RADIUS[t] || 4.5;
  // ONE transform pair for the whole canvas. draw() translates by (W/2 + view.x, …) then
  // scales by view.k, and the hit test inverts exactly that — including devicePixelRatio, which the
  // ctx.setTransform(dpr,…) applies to the bitmap only, so both sides work in CSS pixels.
  const offX = () => W / 2 + view.x, offY = () => H / 2 + view.y;
  const toScreen = (wx, wy) => ({x: offX() + wx * view.k, y: offY() + wy * view.k});
  const toWorld = (px, py) => ({x: (px - offX()) / view.k, y: (py - offY()) / view.k});

  // Which labels are painted at the moment — shared by draw() and the label hit test so a
  // node's caption is exactly as clickable as the node itself.
  const labelVisible = n => {
    if (!visible(n)) return false;
    const focus = selected || hover, near = focus ? adj.get(focus.id) : null;
    const hoverNear = hover && hover !== focus ? adj.get(hover.id) : null;
    const isMatch = searchMatches.some(m => m.id === n.id);
    return n.type === 'hub' || n.type === 'dept' || n.type === 'inbox' || n === focus || n === hover || isMatch
        || (near && near.has(n.id) && n.type !== 'notebook')
        || (hoverNear && hoverNear.has(n.id) && n.type !== 'notebook')
        || (isoSet && n.type !== 'notebook') || fresh(n)
        || (n.type === 'sub' && view.k > .6);
  };
  const labelFontPx = () => 11 / Math.max(.7, Math.min(1.4, view.k));
  const labelText = n => {                               // long names are cut so they cannot cover neighbours
    const t = n.id.replace(/-/g, ' ');
    return (t.length <= 22 || n === hover || n === selected) ? t : t.slice(0, 21).trimEnd() + '…';
  };
  function labelBand(n){                                 // screen-space box around a node's caption
    const txt = labelText(n);
    ctx.save(); ctx.font = `${labelFontPx()}px ${FONT}`;
    const w = ctx.measureText(txt).width * view.k;       // world font × zoom → on-screen width
    ctx.restore();
    const s = toScreen(n.x, n.y);
    const gap = ((RADIUS[n.type] || 4.5) + 13 / Math.max(.7, view.k)) * view.k;
    return {x: s.x, y: s.y + gap, w: Math.max(18, w) + 14, h: Math.max(15, labelFontPx() * view.k * 1.6)};
  }
  // Nearest node wins; on overlap the front-most (last drawn) node wins; if no blob is hit, the
  // node whose *label* sits under the pointer is picked. This is the whole clickable surface.
  const pick = (px, py) => {
    const n = GM.pick(nodes, toWorld(px, py), view.k, visible, radiusOf);
    if (n) return n;
    for (let i = nodes.length - 1; i >= 0; i--){
      const c = nodes[i];
      if (!labelVisible(c)) continue;
      const b = labelBand(c);
      if (Math.abs(px - b.x) <= b.w / 2 && Math.abs(py - b.y) <= b.h / 2) return c;
    }
    return null;
  };

  function draw(){
    const now = performance.now();
    if (flyAnim){
      const u = Math.min(1, (now - flyAnim.t0) / flyAnim.dur);
      const e = 1 - Math.pow(1 - u, 3);
      view.x = flyAnim.x0 + (flyAnim.x1 - flyAnim.x0) * e;
      view.y = flyAnim.y0 + (flyAnim.y1 - flyAnim.y0) * e;
      view.k = flyAnim.k0 + (flyAnim.k1 - flyAnim.k0) * e;
      if (u >= 1) flyAnim = null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

    drawBackdrop();                                    // soft gradient + vignette, drawn from theme tokens

    ctx.save(); ctx.translate(offX(), offY()); ctx.scale(view.k, view.k);

    // Fade-in stagger when the graph opens: a quick whole-scene fade plus a per-node stagger.
    const sceneFade = (!revealT0 || REDUCE) ? 1 : Math.min(1, (now - revealT0) / 320);
    const revealAt = i => {
      if (!revealT0 || REDUCE) return 1;
      const u = (now - revealT0 - (revealTotal ? (i / revealTotal) * 380 : 0)) / 340;
      return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    };
    const focus = selected || hover, near = focus ? adj.get(focus.id) : null;
    const hoverNear = hover && hover !== focus ? adj.get(hover.id) : null;
    // Hover is never shadowed by the selection: dimming still follows the selection
    // (or hover when nothing is selected), but every hovered node keeps its own
    // lit node + neighbours so a different node always responds to the cursor.
    const lit = new Set();
    if (focus){ lit.add(focus.id); for (const id of adj.get(focus.id) || []) lit.add(id); }
    if (hover && hover !== focus){ lit.add(hover.id); for (const id of adj.get(hover.id) || []) lit.add(id); }
    const matchSet = searchMatches.length ? new Set(searchMatches.map(m => m.id)) : null;

    // Department colour halos behind clusters
    const deptCenters = new Map();
    for (const n of nodes){
      if (!visible(n)) continue;
      const key = n.group || (n.type === 'inbox' ? INBOX_GROUP : '');
      if (!key) continue;
      const c = key === INBOX_GROUP ? INBOX : (GROUP[key] || NEUTRAL);
      const g = deptCenters.get(key) || {x: 0, y: 0, count: 0, c};
      g.x += n.x; g.y += n.y; g.count++;
      deptCenters.set(key, g);
    }
    for (const [, g] of deptCenters){
      if (g.count < 2) continue;
      const gx = g.x / g.count, gy = g.y / g.count;
      const rad = 85;
      const gr = ctx.createRadialGradient(gx, gy, 8, gx, gy, rad);
      gr.addColorStop(0, `rgba(${g.c.join(',')},${(LIGHT ? 0.08 : 0.12) * sceneFade})`);
      gr.addColorStop(1, `rgba(${g.c.join(',')},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(gx, gy, rad, 0, Math.PI * 2); ctx.fill();
    }

    // Curved links: a gentle quadratic bow (stable per pair) with a slow flow running along them.
    const flowOff = REDUCE ? 0 : -((now * 0.02) / view.k) % 20;
    for (const l of links){
      if (!visible(l.a) || !visible(l.b)) continue;
      const hot = (focus && (l.a === focus || l.b === focus)) || (hover && (l.a === hover || l.b === hover)),
            c = colorOf(l.a.type === 'hub' ? l.b : l.a);
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
      const bow = Math.min(54, d * 0.12) * (hash(l.a.id + '~' + l.b.id) % 2 ? 1 : -1);
      const cxp = (l.a.x + l.b.x) / 2 - (dy / d) * bow, cyp = (l.a.y + l.b.y) / 2 + (dx / d) * bow;
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.quadraticCurveTo(cxp, cyp, l.b.x, l.b.y);
      ctx.strokeStyle = `rgba(${c.join(',')},${(hot ? .88 : focus ? .07 : .24) * sceneFade})`;
      ctx.lineWidth = (hot ? 2 : 1) / view.k; ctx.stroke();
      if (!REDUCE){                                    // subtle flow travelling along the same curve
        ctx.save(); ctx.setLineDash([5 / view.k, 15 / view.k]); ctx.lineDashOffset = flowOff;
        ctx.strokeStyle = `rgba(${c.join(',')},${(hot ? .5 : .10) * sceneFade})`;
        ctx.lineWidth = 1.4 / view.k; ctx.stroke(); ctx.restore();
      }
    }

    // Live edge pulses travelling along links when notes are read/written/focused
    for (let i = edgePulses.length - 1; i >= 0; i--){
      const p = edgePulses[i];
      const u = (now - p.born) / p.dur;
      if (u >= 1){ edgePulses.splice(i, 1); continue; }
      if (!visible(p.from) || !visible(p.to)) continue;
      const px = p.from.x + (p.to.x - p.from.x) * u;
      const py = p.from.y + (p.to.y - p.from.y) * u;
      const c = colorOf(p.to.type === 'hub' ? p.from : p.to);
      ctx.beginPath(); ctx.arc(px, py, 3.2 / view.k, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.join(',')},${1 - u * 0.6})`;
      ctx.shadowColor = `rgba(${c.join(',')},1)`; ctx.shadowBlur = 12;
      ctx.fill(); ctx.shadowBlur = 0;
    }

    // Nodes, layered by depth: nearer layers are larger, brighter and cast a soft ambient shadow.
    for (let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if (!visible(n)) continue;
      const rv = revealAt(i) * sceneFade;
      if (rv <= 0) continue;
      const c = colorOf(n), lay = layerOf(n), dep = lay / LAYER_N;
      const isHot = n === hover;
      const breath = REDUCE ? 1 : 1 + 0.03 * Math.sin(now / 900 + (hash(n.id) % 7) * 1.1);
      let r = (RADIUS[n.type] || 4.5) * (1.16 - dep * 0.30) * breath;   // size by layer
      if (isHot) r *= 1.22;                                            // hover lift
      const ny = n.y - (isHot && !REDUCE ? 3 / view.k : 0);
      const isMatch = matchSet && matchSet.has(n.id);
      const dim = (focus || matchSet) && !isMatch && !lit.has(n.id) && !fresh(n);
      if (lay <= 2 && !dim){                                           // soft ambient shadow
        const sg = ctx.createRadialGradient(n.x, ny + r * .7, 0, n.x, ny + r * .7, r * 3.1);
        sg.addColorStop(0, `rgba(${SH},${(LIGHT ? .10 : .34) * rv})`);
        sg.addColorStop(1, `rgba(${SH},0)`);
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(n.x, ny + r * .7, r * 3.1, 0, Math.PI * 2); ctx.fill();
      }
      if (n.type === 'hub' && !dim){                                   // the hub's own distinct aura
        ctx.beginPath(); ctx.arc(n.x, ny, r * 3.2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${c.join(',')},${.20 * rv})`; ctx.lineWidth = 1.4 / view.k; ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x, ny, r * 2.1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c.join(',')},${.10 * rv})`; ctx.fill();
      } else if (!dim && (n.type === 'dept' || n === selected || isHot || isMatch)){
        ctx.beginPath(); ctx.arc(n.x, ny, r * (isMatch ? 2.4 : 1.85), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c.join(',')},${(isMatch ? 0.28 : 0.14) * rv})`;
        ctx.fill();
      }
      // Spark ring when a node is newly born or pulsed
      const sp = nodeSparks.get(n.id);
      if (sp && now - sp < 1100){
        const su = (now - sp) / 1100;
        ctx.beginPath(); ctx.arc(n.x, ny, r + su * 22, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${c.join(',')},${(1 - su) * 0.9})`;
        ctx.lineWidth = 2 / view.k; ctx.stroke();
      } else if (sp){
        nodeSparks.delete(n.id);
      }
      ctx.beginPath(); ctx.arc(n.x, ny, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.join(',')},${(dim ? .16 : (.98 - dep * .22)) * rv})`;   // brighter foreground
      ctx.shadowColor = `rgba(${c.join(',')},.85)`;
      ctx.shadowBlur = dim ? 0 : (isMatch ? 20 : isHot ? 22 : lay <= 1 ? 16 : lay >= 4 ? 4 : 10);
      ctx.fill(); ctx.shadowBlur = 0;
      if (n === selected || isMatch){
        ctx.lineWidth = (isMatch ? 2.4 : 2) / view.k;
        ctx.strokeStyle = isMatch ? '#4fe6f5' : `rgb(${INK})`;
        ctx.stroke();
      } else if (isHot){
        ctx.lineWidth = 1.6 / view.k;                 // hover ring, distinct from the selection ring
        ctx.strokeStyle = `rgba(${c.join(',')},.9)`;
        ctx.stroke();
      }
    }
    // Overlays: notes Atlas touched (amber = read, green = wrote), fresh notes on the timeline,
    // folded departments, and the ⇧-drag link line.
    for (const n of nodes){
      if (!visible(n)) continue;
      const r = (RADIUS[n.type] || 4.5) + 6 / view.k, t = touched.get(n.id);
      if (t){
        const u = (now - t.at) / 60000;
        if (u >= 1) touched.delete(n.id);
        else {
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${(t.kind === 'write' ? GREEN : AMBER).join(',')},${.9 * (1 - u)})`;
          ctx.lineWidth = 2.2 / view.k; ctx.stroke();
        }
      }
      if (fresh(n)){
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2);
        ctx.setLineDash([3 / view.k, 3 / view.k]); ctx.strokeStyle = `rgba(${GREEN.join(',')},.95)`;
        ctx.lineWidth = 1.6 / view.k; ctx.stroke(); ctx.setLineDash([]);
      }
      if (n.type === 'dept' && collapsed.has(n.group)){
        const hidden = nodes.reduce((c, m) => c + (m.group === n.group && m.type !== 'dept' && typeOn(m) ? 1 : 0), 0);
        const bx = n.x + r, by = n.y - r, br = 9 / view.k;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${colorOf(n).join(',')},.95)`; ctx.fill();
        ctx.fillStyle = `rgb(${BG})`; ctx.font = `700 ${9 / view.k}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+' + hidden, bx, by + .5 / view.k); ctx.textBaseline = 'alphabetic';
      }
    }
    if (linkDrag){
      const w = toWorld(linkDrag.px, linkDrag.py), f = linkDrag.from;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(w.x, w.y);
      ctx.setLineDash([6 / view.k, 5 / view.k]); ctx.strokeStyle = `rgba(${GREEN.join(',')},.95)`;
      ctx.lineWidth = 2 / view.k; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = `${labelFontPx()}px ${FONT}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if (!labelVisible(n)) continue;
      const rv = revealAt(i) * sceneFade;
      if (rv <= 0) continue;
      const isMatch = matchSet && matchSet.has(n.id);
      const dim = (focus || matchSet) && !isMatch && !lit.has(n.id) && !fresh(n);
      const dep = layerOf(n) / LAYER_N;
      ctx.fillStyle = `rgba(${INK},${(dim ? .30 : (.96 - dep * .28)) * rv})`;
      ctx.fillText(labelText(n), n.x, n.y + (RADIUS[n.type] || 4.5) + 13 / Math.max(.7, view.k));
    }
    ctx.restore();
    drawMini();
  }

  // Minimap: every node on stage plus the rectangle you are looking at. Click or drag it to move.
  function drawMini(){
    if (!mctx || !W || mini.offsetParent === null) return;
    const vis = nodes.filter(visible); if (!vis.length) return;
    const mw = mini.clientWidth, mh = mini.clientHeight;
    if (mini.width !== Math.round(mw * dpr)){ mini.width = Math.round(mw * dpr); mini.height = Math.round(mh * dpr); }
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const a of vis){ x0 = Math.min(x0, a.x); x1 = Math.max(x1, a.x); y0 = Math.min(y0, a.y); y1 = Math.max(y1, a.y); }
    x0 -= 40; y0 -= 40; x1 += 40; y1 += 40;
    const s = Math.min(mw / (x1 - x0), mh / (y1 - y0));
    const ox = (mw - (x1 - x0) * s) / 2 - x0 * s, oy = (mh - (y1 - y0) * s) / 2 - y0 * s;
    miniT = {s, ox, oy};
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0); mctx.clearRect(0, 0, mw, mh);
    for (const n of vis){
      mctx.fillStyle = `rgb(${colorOf(n).join(',')})`;
      mctx.beginPath(); mctx.arc(ox + n.x * s, oy + n.y * s, n.type === 'hub' ? 2.8 : n.type === 'dept' ? 2.2 : 1.3, 0, Math.PI * 2); mctx.fill();
    }
    const a = toWorld(0, 0), b = toWorld(W, H);
    mctx.strokeStyle = `rgba(${ACCENT},.95)`; mctx.lineWidth = 1;
    mctx.strokeRect(ox + a.x * s + .5, oy + a.y * s + .5, (b.x - a.x) * s, (b.y - a.y) * s);
  }
  if (mini){
    const jump = e => {
      if (!miniT) return;
      const r = mini.getBoundingClientRect();
      flyAnim = null; viewSaved = null;
      view.x = -((e.clientX - r.left - miniT.ox) / miniT.s) * view.k;
      view.y = -((e.clientY - r.top - miniT.oy) / miniT.s) * view.k;
      draw();
    };
    mini.addEventListener('pointerdown', e => { mini.setPointerCapture(e.pointerId); jump(e); });
    mini.addEventListener('pointermove', e => { if (mini.hasPointerCapture(e.pointerId)) jump(e); });
    mini.addEventListener('dblclick', () => fitTo(nodes.filter(visible), true));
  }

  function drawBackdrop(){
    const cx = W / 2, cy = H / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * .78);
    g.addColorStop(0, `rgba(${ACCENT},${LIGHT ? .10 : .16})`);
    g.addColorStop(.5, `rgba(${BG},0)`);
    g.addColorStop(1, `rgba(${BG},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .34, W / 2, H / 2, Math.max(W, H) * .72);
    v.addColorStop(0, `rgba(${SH},0)`);
    v.addColorStop(1, `rgba(${SH},${LIGHT ? .10 : .40})`);
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  function loop(){
    if (ov.hidden || document.hidden){ raf = 0; return; }
    const now = performance.now();
    if (W){
      const settled = alpha <= 0.021 && !drag;         // forces have stopped; skip the O(n²) pass
      if (!settled && !tl.on) step();                 // timeline replays growth in place, so no layout
      if (tl.playing) tickTimeline(now);
      // Recompute hover from the last pointer position every frame, so the highlight
      // never goes stale while the graph settles, flies, or after a refresh.
      if (pointerIn && !drag && !pan && lastPX != null){
        const h = pick(lastPX, lastPY);
        if (h !== hover){ hover = h; setCursor(); }
      }
      const busy = !settled || flyAnim || edgePulses.length > 0 || nodeSparks.size > 0 || drag || pan || tl.playing || linkDrag;
      // Idle motion (breathing / parallax / flow) redraws on a ~30fps budget; with reduced
      // motion the canvas is static and only redraws on demand.
      if (busy || (!REDUCE && now - lastDraw > 32)){ draw(); lastDraw = now; }
    }
    const activeAnim = alpha > 0.021 || flyAnim || edgePulses.length > 0 || nodeSparks.size > 0 || drag || pan || tl.playing || !REDUCE;
    raf = activeAnim ? requestAnimationFrame(loop) : 0;
  }
  const setCursor = () => cv.classList.toggle('node-hover', !!(hover && !drag));

  async function openNote(n){
    if (editing && editing.id !== n.id){
      if (isDirty()){ editMsg('Save or cancel this edit first.'); return; }
      stopEdit();
    }
    if (iso && iso.id !== n.id && !editing) setIsolate(n.id, iso.depth);   // isolate walks with you
    selected = n; alpha = Math.max(alpha, .15); syncToDept(n);
    $b('brSuggest').hidden = true;
    pulseNode(n.id, 'read');
    const note = $b('brText');
    note._raw = ''; note._noteId = n.id; note.scrollTop = 0;
    $b('brTitle').textContent = n.id; $b('brPath').textContent = '';
    note.innerHTML = '<p class="md-p md-loading">loading…</p>';
    const box = $b('brLinks'); box.textContent = '';
    for (const id of [...(adj.get(n.id) || [])].sort()){
      const b = document.createElement('button'); b.textContent = id.replace(/-/g, ' ');
      b.onclick = () => { const t = byId.get(id); if (t){ if (!visible(t)) { if (t.type === 'notebook') $b('brNotebooks').checked = true; else $b('brShared').checked = true; } flyTo(t, 1.15); openNote(t); } };
      box.appendChild(b);
    }
    try {
      const r = await fetch('/api/brain/note?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(r => r.json());
      if (selected !== n) return;
      $b('brPath').textContent = r.path || '';
      const text = r.text || r.error || '';
      note._raw = text;
      if (window.AtlasMarkdown) note.innerHTML = AtlasMarkdown.render(text);
      else note.textContent = text;
      note.scrollTop = 0;
      $b('brEdit').disabled = r.editable === false;
      $b('brEdit').title = r.editable === false ? 'This note is too large to edit here' : 'Edit this note (E)';
      loadSuggest(n);
    } catch (_) { note._raw = ''; note.innerHTML = '<p class="md-p">could not load note</p>'; }
  }

  // [[wikilinks]] render as links that jump straight to that node in the graph
  $b('brText').addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a.md-wikilink');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    const id = a.dataset.node;
    const t = byId.get(id) || [...byId.values()].find(x => x.id.toLowerCase() === String(id).toLowerCase());
    if (!t) return;
    if (!visible(t)){ if (t.type === 'notebook') $b('brNotebooks').checked = true; else $b('brShared').checked = true; }
    flyTo(t, 1.3); openNote(t);
  });

  const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const endPointer = () => { drag = null; pan = null; linkDrag = null; moved = false; downId = null; cv.classList.remove('drag'); };
  cv.addEventListener('pointerdown', e => {
    if (downId !== null) return;                       // ignore a second pointer while a gesture is live
    cv.setPointerCapture(e.pointerId);
    const [px, py] = pos(e); moved = false;
    downX = e.clientX; downY = e.clientY; downId = e.pointerId;
    const n = pick(px, py);
    if (n && e.shiftKey){ linkDrag = {from: n, px, py}; cv.classList.add('drag'); return; }
    if (n){ drag = n; cv.classList.add('drag'); }      // grabbing cursor while dragging a node too
    else { pan = {x: e.clientX, y: e.clientY, vx: view.x, vy: view.y}; cv.classList.add('drag'); viewSaved = null; }
  });
  cv.addEventListener('pointermove', e => {
    if (downId !== null && e.pointerId !== downId) return;
    const [px, py] = pos(e);
    lastPX = px; lastPY = py; pointerIn = true;
    if (linkDrag){
      linkDrag.px = px; linkDrag.py = py;
      const h = pick(px, py); hover = h !== linkDrag.from ? h : null; draw();
      return;
    }
    if (drag || pan){
      // A click is only a drag once the pointer has moved past the threshold, so a
      // jittery click still selects instead of silently becoming a drag.
      if (!moved && GM.moved({x: downX, y: downY}, {x: e.clientX, y: e.clientY})) moved = true;
      if (moved){
        if (drag){ const w = toWorld(px, py); drag.x = w.x; drag.y = w.y; alpha = Math.max(alpha, .3); if (!raf) loop(); }
        else { view.x = pan.vx + e.clientX - pan.x; view.y = pan.vy + e.clientY - pan.y; if (!raf) loop(); }
      }
    } else {
      const h = pick(px, py); if (h !== hover){ hover = h; setCursor(); draw(); }
    }
  });
  cv.addEventListener('pointerup', e => {
    if (downId !== null && e.pointerId !== downId) return;
    const [px, py] = pos(e);
    lastPX = px; lastPY = py;
    if (linkDrag){
      const from = linkDrag.from, to = pick(px, py);
      endPointer(); hover = to; setCursor(); draw();
      if (to && to !== from) linkNotes(from.id, to.id);
      return;
    }
    const wasMoved = moved, dropped = drag;
    endPointer();
    if (wasMoved && dropped){ dropped.pinned = true; pins[dropped.id] = [dropped.x, dropped.y]; savePins(); }
    if (!wasMoved){ const n = pick(px, py); if (n) openNote(n); else { selected = null; syncToDept(null); } }
    hover = pick(px, py);                              // clear a stale hover left by a drag/pan
    setCursor();
    if (!raf) loop(); else draw();
  });
  cv.addEventListener('dblclick', e => {               // release a pinned node back to the layout
    const n = pick(...pos(e));
    if (n && n.pinned){ n.pinned = false; delete pins[n.id]; savePins(); alpha = Math.max(alpha, .3); if (!raf) loop(); }
  });
  cv.addEventListener('pointercancel', () => { endPointer(); if (pointerIn) hover = pick(lastPX, lastPY); setCursor(); if (!raf) loop(); });
  cv.addEventListener('lostpointercapture', () => { if (downId !== null){ endPointer(); setCursor(); } });
  cv.addEventListener('pointerleave', () => { pointerIn = false; if (hover){ hover = null; setCursor(); draw(); } });
  cv.addEventListener('pointerenter', e => { const [px, py] = pos(e); pointerIn = true; lastPX = px; lastPY = py; });
  // Two-finger scroll pans; pinch (the browser reports it as ctrlKey) or ⌘/Ctrl+scroll zooms.
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    viewSaved = null; flyAnim = null;                  // a manual move is the new "restore" home
    const line = e.deltaMode === 1 ? 16 : 1;           // some mice report lines, not pixels
    if (e.ctrlKey || e.metaKey){ const [px, py] = pos(e); Object.assign(view, GM.zoomAt(view, e.deltaY * line, px, py, W, H)); }
    else { view.x -= e.deltaX * line; view.y -= e.deltaY * line; }
    draw();
  }, {passive: false});

  // Search box with fly-to + accessible outline toggle + live tool edge pulses
  const searchInput = $b('brSearch'), searchCount = $b('brSearchCount');
  const outlineBtn = $b('brOutlineToggle'), outlineBox = $b('brOutline');
  const saveView = () => { if (!viewSaved) viewSaved = {x: view.x, y: view.y, k: view.k}; };
  const restoreView = () => {                          // put the camera back where it was before the search
    if (!viewSaved) return;
    const v = viewSaved; viewSaved = null;
    flyAnim = {t0: performance.now(), dur: 320, x0: view.x, y0: view.y, k0: view.k, x1: v.x, y1: v.y, k1: v.k};
    if (!raf) loop();
  };
  function updateSearch(fly = false){
    searchQuery = (searchInput?.value || '').toLowerCase().trim();
    if (!searchQuery){
      searchMatches = []; searchIdx = 0;
      if (searchCount) searchCount.hidden = true;
      restoreView();
      renderOutline(); draw();
      return;
    }
    searchMatches = nodes.filter(n => n.id.toLowerCase().includes(searchQuery) || (n.group || '').toLowerCase().includes(searchQuery));
    if (searchCount){
      searchCount.hidden = false;
      searchCount.textContent = searchMatches.length ? `${(searchIdx % searchMatches.length) + 1}/${searchMatches.length}` : '0';
    }
    if (searchMatches.length && fly){                   // only Enter / a click on a result flies + opens
      const target = searchMatches[searchIdx % searchMatches.length];
      saveView();
      flyTo(target, 1.35);
      openNote(target);
    } else {
      draw();
    }
    renderOutline();
  }
  if (searchInput){
    searchInput.addEventListener('input', () => { searchIdx = 0; updateSearch(false); });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && searchMatches.length){
        e.preventDefault();
        searchIdx = (searchIdx + (e.shiftKey ? searchMatches.length - 1 : 1)) % searchMatches.length;
        updateSearch(true);
      } else if (e.key === 'Escape' && searchInput.value){
        e.stopPropagation();
        searchInput.value = ''; updateSearch(false);
      }
    });
  }
  if (outlineBtn && outlineBox){
    outlineBtn.addEventListener('click', () => {
      const on = outlineBox.hidden;
      outlineBox.hidden = !on;
      outlineBtn.setAttribute('aria-pressed', String(on));
      if (on) renderOutline();
    });
    outlineBox.addEventListener('click', e => {
      const b = e.target.closest('[data-node]'); if (!b) return;
      const n = byId.get(b.dataset.node);
      if (n){ outlineBox.hidden = true; outlineBtn.setAttribute('aria-pressed', 'false'); flyTo(n, 1.3); openNote(n); }
    });
  }

  // ══ small helpers ══
  const pretty = id => String(id).replace(/-/g, ' ');
  const escA = s => esc(s).replace(/"/g, '&quot;');
  const post = (url, body) => fetch(url, {method: 'POST', headers: apiHeaders({'content-type': 'application/json'}), body: JSON.stringify(body)})
    .then(async r => ({status: r.status, ...(await r.json().catch(() => ({})))}))
    .catch(() => ({ok: false, error: 'Could not reach the dashboard server.'}));
  const actEl = $b('brActivity'); let actTimer = 0;
  const chip = (text, ms = 2400) => {                  // small status line on the graph (top-left)
    if (!actEl) return;
    clearTimeout(actTimer); actEl.textContent = text || ''; actEl.hidden = !text;
    if (text && ms) actTimer = setTimeout(() => { actEl.hidden = true; }, ms);
  };
  const navPing = () => { const b = $b('navBrain'); if (!b) return; b.classList.remove('brain-ping'); void b.offsetWidth; b.classList.add('brain-ping'); };

  // ══ Atlas ↔ Brain: voice actions, and notes lighting up as Atlas reads or writes them ══
  const WRITE_TOOL = /write|patch|edit|create|append|save|replace|insert|move/i;
  let runWrote = false;
  const notesIn = inp => nodes.filter(n => n.id.length > 3 && (inp.includes('/' + n.id + '.md') || inp.includes('[[' + n.id)
                                                            || (n.id.length > 5 && inp.includes(n.id))));
  const origBrainHandle = handle;
  handle = ev => {
    try {
      if (ev.t === 'ui' && ev.ui && ev.ui.view === 'brain') voiceAction(ev.ui);
      else if (ev.t === 'tool' && ev.phase === 'use' && nodes.length){
        const inp = String(ev.input || ''), write = WRITE_TOOL.test(ev.name || '');
        if (write && /atlas/i.test(inp)) runWrote = true;
        const hit = notesIn(inp);
        for (const n of hit){ touched.set(n.id, {at: performance.now(), kind: write ? 'write' : 'read'}); pulseNode(n.id, 'tool'); }
        if (hit.length){ chip(`◉ Atlas is ${write ? 'writing' : 'reading'} ${pretty(hit[0].id)}${hit.length > 1 ? ` +${hit.length - 1}` : ''}`, 0); if (ov.hidden) navPing(); }
      } else if (ev.t === 'complete' || ev.t === 'error'){
        if (runWrote && !ov.hidden) load();            // new or changed notes appear without a refresh
        runWrote = false;
        if (actEl && !actEl.hidden && /^◉/.test(actEl.textContent)) chip(actEl.textContent.replace(/^◉ Atlas is (read|writ)ing/, (m, v) => '✓ Atlas ' + (v === 'read' ? 'read' : 'wrote')), 2500);
      }
    } catch (_) {}
    return origBrainHandle(ev);
  };
  async function showBrain(id){
    if (NAV()) for (const k in NAV().views) if (k !== 'brain' && NAV().views[k].close) NAV().views[k].close();
    if (!isOpen()) return open(id);
    const n = id && byId.get(id);
    if (n){ flyTo(n, Math.max(view.k, 1.25)); openNote(n); }
  }
  async function voiceAction(a){
    if (a.action === 'close') return close();
    if (a.action === 'open') return showBrain(a.id);
    await showBrain(a.action === 'isolate' ? a.id : undefined);
    if (a.action === 'isolate' && byId.get(a.id)) setIsolate(a.id, 1);
    else if (a.action === 'search' && searchInput){ searchInput.value = a.q || ''; searchIdx = 0; updateSearch(false); chip(`No note called “${a.q}”. Closest matches are highlighted.`, 4000); }
    else if (a.action === 'timeline'){ selected = null; syncToDept(null); showTimeline(true); }   // let the new notes stand out
  }

  // ══ isolate: a note and its neighbours, 1 or 2 hops ══
  function setIsolate(id, depth = 1, refit = true){
    if (!id || !byId.get(id)){ iso = null; isoSet = null; }
    else {
      iso = {id, depth}; isoSet = new Set([id]); let edge = [id];
      for (let d = 0; d < depth; d++){
        const next = [];
        for (const f of edge) for (const nb of adj.get(f) || []) if (!isoSet.has(nb)){ isoSet.add(nb); next.push(nb); }
        edge = next;
      }
    }
    const b = $b('brIsolate');
    b.setAttribute('aria-pressed', String(!!iso));
    b.textContent = iso ? `Isolate · ${iso.depth} hop${iso.depth > 1 ? 's' : ''}` : 'Isolate';
    renderOutline();
    if (refit) fitTo(nodes.filter(visible), true); else draw();
  }
  const cycleIsolate = () => {
    const n = selected || hover;
    if (!iso){ if (n) setIsolate(n.id, 1); else chip('Select a note first, then isolate it'); }
    else if (iso.depth === 1) setIsolate(iso.id, 2);
    else setIsolate(null);
  };

  // ══ fold a department into its node ══
  function toggleFold(slug){
    if (collapsed.has(slug)) collapsed.delete(slug); else collapsed.add(slug);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...collapsed])); } catch (_) {}
    if (selected && !visible(selected)){ selected = null; syncToDept(null); }
    alpha = Math.max(alpha, .3); legend(); renderOutline();
    if (!raf && !ov.hidden) loop(); else draw();
  }
  $b('brLegend').addEventListener('click', e => { const b = e.target.closest('[data-fold]'); if (b) toggleFold(b.dataset.fold); });

  // ══ arrow keys: hop to the linked note that lies in that direction ══
  function hop(dx, dy){
    const from = selected && visible(selected) ? selected : null;
    if (!from){ const s = byId.get('Atlas') || nodes.find(visible); if (s){ flyTo(s, view.k); openNote(s); } return; }
    const best = list => {
      let b = null, bs = -1e9;
      for (const n of list){
        if (!n || n === from || !visible(n)) continue;
        const vx = n.x - from.x, vy = n.y - from.y, d = Math.hypot(vx, vy) || 1, cos = (vx * dx + vy * dy) / d;
        if (cos < .35) continue;                       // roughly that way
        const s = cos * 1.5 - d / 300;                 // straight ahead first, then nearest
        if (s > bs){ bs = s; b = n; }
      }
      return b;
    };
    const n = best([...(adj.get(from.id) || [])].map(id => byId.get(id))) || best(nodes);
    if (n){ flyTo(n, view.k); openNote(n); }
  }

  // ══ edit in place, with [[ autocomplete ══
  const editor = $b('brEditor'), ac = $b('brAC');
  const editMsg = t => { $b('brEditMsg').textContent = t || ''; };
  let editing = null;                                  // {id, mtime, orig, armed}
  const isDirty = () => !!editing && editor.value !== editing.orig;
  async function startEdit(){
    const n = selected; if (!n || editing) return;
    let r = null;
    try { r = await fetch('/api/brain/note?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(x => x.json()); } catch (_) {}
    if (!r || r.error){ chip('Could not load this note for editing'); return; }
    if (r.editable === false){ chip('This note is too large to edit here'); return; }
    editing = {id: n.id, mtime: r.mtime, orig: r.text, armed: false};
    editor.value = r.text; editor.hidden = false; $b('brEditBar').hidden = false; $b('brText').hidden = true;
    $b('brEdit').setAttribute('aria-pressed', 'true');
    editMsg('⌘S save · Esc cancel · type [[ to link');
    editor.focus(); editor.setSelectionRange(r.text.length, r.text.length);
  }
  function stopEdit(){
    editing = null; editor.hidden = true; ac.hidden = true;
    $b('brEditBar').hidden = true; $b('brText').hidden = false; $b('brEdit').setAttribute('aria-pressed', 'false');
  }
  async function saveEdit(){
    if (!editing) return;
    const {id, mtime} = editing;
    editMsg('Saving…');
    const res = await post('/api/brain/note', {id, text: editor.value, base_mtime: mtime});
    if (!res.ok){
      editMsg(res.status === 409 ? 'This note changed on disk since you opened it. Copy your text, cancel, and edit again.' : (res.error || 'Could not save.'));
      return;
    }
    stopEdit();
    touched.set(id, {at: performance.now(), kind: 'write'});
    await load();
    const n = byId.get(id);
    if (n){ openNote(n); pulseNode(id, 'write'); }
    chip(`✓ Saved ${pretty(id)}`);
  }
  let acItems = [], acSel = 0;
  function acUpdate(){
    const m = /\[\[([^\]\[\n|#]{0,40})$/.exec(editor.value.slice(0, editor.selectionStart));
    if (!m){ ac.hidden = true; return; }
    const q = m[1].toLowerCase().replace(/[-_\s]+/g, ' ').trim();
    const norm = id => id.toLowerCase().replace(/[-_]+/g, ' ');
    acItems = nodes.map(n => n.id).filter(id => !q || norm(id).includes(q))
      .sort((a, b) => (norm(a).startsWith(q) ? 0 : 1) - (norm(b).startsWith(q) ? 0 : 1) || a.length - b.length).slice(0, 7);
    if (!acItems.length){ ac.hidden = true; return; }
    acSel = 0; ac.hidden = false;
    ac.innerHTML = acItems.map((id, i) => `<button type="button" role="option" data-ac="${i}" aria-selected="${i === 0}">${esc(id)}</button>`).join('');
  }
  function acPick(i){
    const id = acItems[i]; if (!id) return;
    const at = editor.selectionStart, start = editor.value.lastIndexOf('[[', at) + 2;
    editor.setRangeText(id + (editor.value.slice(at).startsWith(']]') ? '' : ']]'), start, at, 'end');
    ac.hidden = true; editor.focus();
  }
  editor.addEventListener('input', () => { if (editing) editing.armed = false; acUpdate(); });
  editor.addEventListener('click', acUpdate);
  ac.addEventListener('mousedown', e => { const b = e.target.closest('[data-ac]'); if (b){ e.preventDefault(); acPick(+b.dataset.ac); } });
  editor.addEventListener('keydown', e => {
    e.stopPropagation();                               // keep Space, letters, arrows and Esc away from the mic, shortcuts and graph
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); saveEdit(); return; }
    if (!ac.hidden){
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        acSel = (acSel + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length;
        [...ac.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === acSel)));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); acPick(acSel); return; }
      if (e.key === 'Escape'){ e.preventDefault(); ac.hidden = true; return; }
    }
    if (e.key === 'Escape'){
      e.preventDefault();
      if (isDirty() && !editing.armed){ editing.armed = true; editMsg('Unsaved changes. Esc again to discard, ⌘S to save.'); return; }
      stopEdit();
    }
  });
  $b('brEdit').addEventListener('click', () => (editing ? (isDirty() ? editMsg('Save or cancel first.') : stopEdit()) : startEdit()));
  $b('brEditSave').addEventListener('click', saveEdit);
  $b('brEditCancel').addEventListener('click', stopEdit);

  // ══ new note (linked to the selected one) ══
  const newForm = $b('brNewForm'), newTitle = $b('brNewTitle');
  function newNote(){
    newForm.hidden = false; $b('brNewMsg').textContent = '';
    $b('brNewNear').textContent = selected ? `linked to ${pretty(selected.id)}` : 'linked to Atlas';
    newTitle.value = ''; newTitle.focus();
  }
  newForm.addEventListener('submit', async e => {
    e.preventDefault();
    const title = newTitle.value.trim(); if (!title) return;
    const res = await post('/api/brain/note', {create: title, near: selected ? selected.id : ''});
    if (!res.ok){ $b('brNewMsg').textContent = res.error || 'Could not create the note.'; return; }
    newForm.hidden = true;
    await load();
    const n = byId.get(res.note.id);
    if (n){ nodeSparks.set(n.id, performance.now()); flyTo(n, Math.max(view.k, 1.1)); await openNote(n); startEdit(); }
  });
  newTitle.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape'){ e.preventDefault(); newForm.hidden = true; } });
  $b('brNewCancel').addEventListener('click', () => { newForm.hidden = true; });
  $b('brNew').addEventListener('click', newNote);

  // ══ links: ⇧-drag, or one click on a suggestion ══
  async function linkNotes(a, b){
    const res = await post('/api/brain/link', {source: a, target: b});
    if (!res.ok){ chip(res.error || 'Could not add the link'); return; }
    touched.set(a, {at: performance.now(), kind: 'write'});
    await load(); pulseNode(a, 'write');
    chip(`✓ Linked ${pretty(a)} → ${pretty(b)}`);
    if (selected && (selected.id === a || selected.id === b) && !editing) openNote(selected);
  }
  async function loadSuggest(n){
    const box = $b('brSuggest');
    let s = null;
    try { s = await fetch('/api/brain/suggest?id=' + encodeURIComponent(n.id), {headers: apiHeaders()}).then(r => r.json()); } catch (_) {}
    if (selected !== n || !s || s.error) return;
    const rows = [...(s.mentions || []).map(x => ({src: n.id, dst: x.id, why: 'named here', snip: x.snippet})),
                  ...(s.mentioned_in || []).map(x => ({src: x.id, dst: n.id, why: 'names this note', snip: x.snippet}))].slice(0, 8);
    if (!rows.length){ box.hidden = true; return; }
    box.innerHTML = '<div class="bs-head">Suggested links</div>' + rows.map((r, i) =>
      `<button type="button" class="bs-item" data-i="${i}" title="${escA(r.snip)}"><b>＋</b>${esc(pretty(r.src === n.id ? r.dst : r.src))}<span>${r.why}</span></button>`).join('');
    box.onclick = e => { const b = e.target.closest('[data-i]'); if (!b || b.disabled) return; b.disabled = true; const r = rows[+b.dataset.i]; linkNotes(r.src, r.dst); };
    box.hidden = false;
  }

  // ══ timeline: replay how the brain grew ══
  const tlBar = $b('brTimeline'), tlRange = $b('brTlRange'), tlLabel = $b('brTlLabel'), tlPlay = $b('brTlPlay'), tlFresh = $b('brTlFresh');
  let freshIdx = 0;
  const fmtWhen = (s, span) => new Date(s * 1000).toLocaleString(undefined,
    span < 3 * 86400 ? {weekday: 'short', hour: '2-digit', minute: '2-digit'} : {day: 'numeric', month: 'short', year: 'numeric'});
  function tlSync(){
    if (!tl.on) return;
    const span = tl.t1 - tl.t0, fr = nodes.filter(fresh);
    tlRange.value = String(Math.round(((tl.t - tl.t0) / (span || 1)) * 1000));
    tlLabel.textContent = `${fmtWhen(tl.t, span)} · ${nodes.filter(n => typeOn(n) && (!n.born || n.born <= tl.t)).length} notes`;
    tlFresh.textContent = fr.length ? `${fr.length} new that week ▸` : 'nothing new that week';
    tlFresh.disabled = !fr.length;
    tlPlay.textContent = tl.playing ? '❚❚' : '▶'; tlPlay.setAttribute('aria-label', tl.playing ? 'Pause' : 'Play');
  }
  function showTimeline(on){
    const b = $b('brTimelineBtn');
    if (!on){ tl.on = tl.playing = false; tlBar.hidden = true; b.setAttribute('aria-pressed', 'false'); renderOutline(); draw(); return; }
    const ts = nodes.map(n => n.born).filter(Boolean);
    if (!ts.length){ chip('No dates found on these notes'); return; }
    Object.assign(tl, {on: true, playing: false, t0: Math.min(...ts) - 60, t1: Math.max(Date.now() / 1000, ...ts)});
    tl.t = tl.t1; freshIdx = 0;
    tlBar.hidden = false; b.setAttribute('aria-pressed', 'true');
    tlSync(); renderOutline(); draw();
    if (!raf && !ov.hidden) loop();
  }
  function tickTimeline(now){
    const before = tl.t;
    tl.t = Math.min(tl.t1, tl.t + (tl.t1 - tl.t0) * Math.min(250, now - tl.last) / 9000);   // whole history in ~9s
    tl.last = now;
    for (const n of nodes) if (n.born > before && n.born <= tl.t) nodeSparks.set(n.id, now);
    if (tl.t >= tl.t1) tl.playing = false;
    tlSync();
  }
  tlPlay.addEventListener('click', () => {
    if (!tl.playing && tl.t >= tl.t1) tl.t = tl.t0;
    tl.playing = !tl.playing; tl.last = performance.now(); tlSync();
    if (!raf && !ov.hidden) loop();
  });
  tlRange.addEventListener('input', () => { tl.playing = false; tl.t = tl.t0 + (tl.t1 - tl.t0) * (+tlRange.value / 1000); tlSync(); renderOutline(); draw(); });
  tlFresh.addEventListener('click', () => { const fr = nodes.filter(fresh); if (!fr.length) return; const n = fr[freshIdx++ % fr.length]; flyTo(n, Math.max(view.k, 1.1)); openNote(n); });
  $b('brTlClose').addEventListener('click', () => showTimeline(false));
  $b('brTimelineBtn').addEventListener('click', () => showTimeline(!tl.on));
  $b('brIsolate').addEventListener('click', cycleIsolate);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !ov.hidden && !raf) loop();
  });

  const navBtn = $b('navBrain'), isOpen = () => !ov.hidden;
  const open = async arg => {
    const want = arg && typeof arg === 'string' ? arg : arg && arg.id;
    // reset every piece of transient interaction state so nothing survives a close/reopen
    hover = null; selected = null; drag = null; pan = null; flyAnim = null; moved = false;
    downId = null; pointerIn = false; lastPX = lastPY = null; viewSaved = null; linkDrag = null;
    iso = null; isoSet = null; $b('brIsolate').setAttribute('aria-pressed', 'false'); $b('brIsolate').textContent = 'Isolate';
    tl.on = tl.playing = false; tlBar.hidden = true; $b('brTimelineBtn').setAttribute('aria-pressed', 'false');
    ov.hidden = false; navBtn.setAttribute('aria-expanded', 'true'); fit(); view = {x: 0, y: 0, k: 1};
    await load(); fitView(); cancelAnimationFrame(raf); setCursor(); loop();
    if (editing && byId.get(editing.id)) selected = byId.get(editing.id);   // an unsaved edit survives close / reopen
    const n = want && byId.get(want);
    if (n){                                           // jump to a specific note (e.g. from Departments)
      flyTo(n, 1.25); openNote(n);
    }
  };
  const close = () => {
    ov.hidden = true; navBtn.setAttribute('aria-expanded', 'false'); cancelAnimationFrame(raf); raf = 0;
    hover = null; drag = null; pan = null; flyAnim = null; moved = false; downId = null; pointerIn = false;
    linkDrag = null; tl.playing = false;
  };
  window.AtlasBrain = {
    open, close, load,
    flyTo: id => { const n = byId.get(id); if (n){ flyTo(n, 1.3); openNote(n); } },
    pulseNode,
    // Read-only introspection (used by tests/automation): the exact screen position of a node in
    // CSS px relative to the canvas, using the SAME transform draw() paints with.
    screenOf: id => { const n = byId.get(id); return n ? toScreen(n.x, n.y) : null; },
    pickAt: (px, py) => { const n = pick(px, py); return n ? n.id : null; },   // canvas CSS px → node id
    nodeIds: () => nodes.filter(visible).map(n => n.id),
    labelShown: id => { const n = byId.get(id); return !!(n && labelVisible(n)); },
    labelOf: id => { const n = byId.get(id); return (n && labelVisible(n)) ? labelBand(n) : null; },
    selectedId: () => (selected ? selected.id : null),
    hoverId: () => (hover ? hover.id : null),
    viewInfo: () => ({x: view.x, y: view.y, k: view.k, W, H, dpr}),
    ready: () => nodes.length > 0,
    settled: () => alpha <= 0.021 && !drag && !pan && !flyAnim,   // forces have stopped, nodes still
    voice: a => voiceAction(a),
    isolate: (id, depth) => setIsolate(id, depth || 1),
    fold: slug => toggleFold(slug),
    timeline: on => showTimeline(on !== false),
    hop: (dx, dy) => hop(dx, dy),
    link: (a, b) => linkNotes(a, b),
    state: () => ({iso: iso && {...iso}, timeline: tl.on, t: tl.t, folded: [...collapsed], editing: editing && editing.id,
                   visible: nodes.filter(visible).length, touched: [...touched.keys()]}),
  };
  const NAV = () => window.AtlasNav;
  const goDept = () => {                              // the selected note's department / team, if it belongs to one
    const n = selected; if (!n || !NAV()) return;
    const d = n.type === 'dept' ? n.id : n.group;
    const team = n.type === 'sub' ? n.id : n.type === 'notebook' ? n.id.replace(/-notebook$/, '') : null;
    NAV().go('departments', {dept: d, team: AtlasData.dept(d)?.teams.some(t => t.slug === team) ? team : null});
  };
  const syncToDept = n => {
    const b = $b('brToDept'), ok = n && (n.type === 'dept' || n.type === 'sub' || n.type === 'notebook') && n.group && AtlasData.dept(n.group);
    b.hidden = !ok;
    if (ok) b.textContent = 'Open ' + (AtlasData.dept(n.group).name) + ' in Departments ▸';
  };
  $b('brToDept').addEventListener('click', goDept);
  if (window.AtlasNav) AtlasNav.views.brain = {open, close, isOpen};
  const tabs = document.createElement('div'); tabs.innerHTML = window.AtlasNav ? AtlasNav.tabs('brain') : '';
  if (tabs.firstElementChild) ov.querySelector('.rhead > span').after(tabs.firstElementChild);
  navBtn.addEventListener('click', () => isOpen() ? close() : (NAV() ? NAV().go('brain') : open()));
  $b('brainClose').addEventListener('click', close);
  $b('brRefresh').addEventListener('click', load);
  document.addEventListener('keydown', e => {
    if (ov.hidden) return;
    const el = document.activeElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || el?.isContentEditable;
    if (e.key === 'Escape'){                           // peel one layer at a time
      if (linkDrag){ endPointer(); draw(); }
      else if (!newForm.hidden) newForm.hidden = true;
      else if (iso) setIsolate(null);
      else if (tl.on) showTimeline(false);
      else if (selected){ selected = null; syncToDept(null); draw(); }
      else close();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const d = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key];
    if (d){ if (el === $b('brText')) return; e.preventDefault(); hop(d[0], d[1]); return; }
    const act = {f: () => fitTo(nodes.filter(visible), true), x: cycleIsolate, l: () => showTimeline(!tl.on),
                 e: () => startEdit(), n: newNote, '/': () => searchInput && searchInput.focus()}[e.key.toLowerCase()];
    if (act){ e.preventDefault(); act(); }
  });
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

  // orb visualizer style picker (orb | waveform | ring)
  const ORBSTYLES = [{id:'orb', label:'Orb'}, {id:'waveform', label:'Waveform'}, {id:'ring', label:'Ring'}];
  const orbGrid = $('#orbStyleGrid');
  if (orbGrid){
    ORBSTYLES.forEach(s => {
      const b = document.createElement('button'); b.className = 'swatch mode'; b.type = 'button';
      b.dataset.orbStyle = s.id; b.innerHTML = `<span>${s.id === 'orb' ? '◉' : s.id === 'waveform' ? '▮' : '◌'}</span>${s.label}`;
      b.onclick = () => window.AtlasOrb && AtlasOrb.setStyle(s.id);
      orbGrid.appendChild(b);
    });
  }
  // display mode picker (normal | ambient)
  const dispGrid = $('#displayModeGrid');
  if (dispGrid){
    [['normal', 'Normal'], ['ambient', 'Ambient']].forEach(([id, label]) => {
      const b = document.createElement('button'); b.className = 'swatch mode'; b.type = 'button';
      b.dataset.displayMode = id; b.innerHTML = `<span>${id === 'ambient' ? '⛶' : '▦'}</span>${label}`;
      b.onclick = () => { if (id === 'ambient') window.AtlasAmbient ? AtlasAmbient.on() : location.hash = '#mode=ambient'; else window.AtlasAmbient ? AtlasAmbient.off() : location.hash = ''; };
      dispGrid.appendChild(b);
    });
  }

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
  const rail = $('#teamRail'), els = {}, timers = {}, teamDept = {};
  const railState = {};                                // slug -> 'working' | 'done', survives a rebuild
  function buildRail(){
    rail.innerHTML = '<div class="tr-title">Departments</div>';
    for (const k in els) delete els[k];
    for (const d of AtlasData.depts){
      const id = d.slug, name = d.name.replace('Business & Operations', 'Business & Ops');
      const b = document.createElement('button'); b.className = 'tr-item'; b.style.setProperty('--c', `var(${AtlasData.colorVar(id)})`);
      b.type = 'button'; b.dataset.dept = id; b.title = `${d.name} — open in Departments`;
      b.innerHTML = `<span class="tr-dot"></span><span class="tr-name">${name.replace(/&/g, '&amp;')}</span><span class="tr-state">idle</span>`;
      b.onclick = () => window.AtlasNav ? AtlasNav.go('departments', {dept: id}) : $('#navDepts')?.click();
      rail.appendChild(b); els[id] = b; teamDept[id] = id;
      d.teams.forEach(t => { teamDept[t.slug] = id; });
      if (railState[id]) setState(id, railState[id]);
    }
  }
  const setState = (id, st) => {
    railState[id] = st || '';
    const b = els[id]; if (!b) return;
    b.classList.remove('working', 'done'); if (st) b.classList.add(st);
    b.querySelector('.tr-state').textContent = st === 'working' ? 'working…' : st === 'done' ? 'done' : 'idle';
  };
  buildRail();
  AtlasData.onChange(buildRail);
  fetch('/api/brain/graph', {headers: apiHeaders()}).then(r => r.json())
    .then(g => (g.nodes || []).forEach(n => { if (n.type === 'sub' || n.type === 'dept') teamDept[n.id] = n.group || n.id; }))
    .catch(() => {});
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

// ══════════ IIFE · status & latency badge, shared overlay transitions, sliding nav indicator ══════════
(() => {
  'use strict';
  const badge = $('#statusBadge'); if (!badge) return;
  const pop = $('#statusPop');
  const latHistory = [];
  const MAX_LAT = 20;
  let runStart = 0, listenStart = 0, firstDeltaAt = 0, bootAt = performance.now(), online = true;

  const fmtMs = ms => (ms == null || !isFinite(ms)) ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  const tier = ms => (ms == null ? 'green' : ms < 1500 ? 'green' : ms < 4000 ? 'amber' : 'red');

  // ── intercept run/state timing (thinking, first token) ──
  const origSetState = setState;
  setState = function(cls, word, sub){
    if (cls === 'running' && !runStart) runStart = performance.now();
    if (cls === 'listening') listenStart = performance.now();
    return origSetState(cls, word, sub);
  };
  const origHandleStatus = handle;
  handle = ev => {
    try {
      if (ev.t === 'latency' && ev.ms != null){
        latHistory.push(ev.ms); if (latHistory.length > MAX_LAT) latHistory.shift();
        $('#spFirst').textContent = fmtMs(ev.ms);
        if (runStart) $('#spStWord').textContent = fmtMs(ev.ms);
        renderLatency();
      } else if (ev.t === 'delta' && !firstDeltaAt){
        firstDeltaAt = performance.now();
        if (runStart) $('#spStThink').textContent = fmtMs(firstDeltaAt - runStart);
      } else if (ev.t === 'complete' || ev.t === 'error'){
        runStart = 0; firstDeltaAt = 0;
      }
    } catch (_) {}
    return origHandleStatus(ev);
  };

  // heard = mic-open → transcription confirm (captured from the action log)
  const logBox = $('#log');
  if (logBox){
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes){
        if (!(n instanceof HTMLElement)) continue;
        const msg = n.querySelector('.msg')?.textContent || '';
        if (/transcribed/.test(msg) && listenStart){
          $('#spStHeard').textContent = fmtMs(performance.now() - listenStart);
          listenStart = 0;
        }
      }
    }).observe(logBox, {childList: true});
  }

  function renderLatency(){
    const last = latHistory[latHistory.length - 1];
    const t = tier(last);
    badge.classList.remove('tier-amber', 'tier-red');
    const tierEl = $('#spTier');
    tierEl.classList.remove('amber', 'red');
    if (t === 'amber'){ badge.classList.add('tier-amber'); tierEl.classList.add('amber'); tierEl.textContent = 'OK'; }
    else if (t === 'red'){ badge.classList.add('tier-red'); tierEl.classList.add('red'); tierEl.textContent = 'SLOW'; }
    else tierEl.textContent = 'FAST';
    $('#sbLat').textContent = fmtMs(last);
    $('#spAvg').textContent = 'avg ' + fmtMs(latHistory.reduce((a, b) => a + b, 0) / latHistory.length);
    const svg = $('#spSpark');
    if (svg){
      const w = 220, h = 38;
      const max = Math.max.apply(null, latHistory.concat(2000));
      const pts = latHistory.map((v, i) => {
        const x = latHistory.length === 1 ? w / 2 : (i / (latHistory.length - 1)) * w;
        const y = h - 3 - (v / max) * (h - 6);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      const line = svg.querySelector('polyline') || document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      if (!svg.contains(line)) svg.appendChild(line);
      line.setAttribute('points', pts.join(' '));
      line.setAttribute('stroke', t === 'green' ? 'var(--green)' : t === 'amber' ? 'var(--amber)' : 'var(--red)');
    }
  }

  function setOnline(ok){
    online = ok;
    badge.classList.remove('tier-amber', 'tier-red');
    if (!ok){
      badge.classList.add('tier-red');
      $('#sbState').textContent = 'Offline';
      $('#sbDot').style.background = 'var(--red)';
      $('#spGw').textContent = 'offline';
      $('#spTitle').textContent = 'RECONNECTING';
      if (window.AtlasOrb) AtlasOrb.setCaption('Reconnecting…', false, 'SYSTEM');
      document.body.classList.add('offline');
    } else {
      $('#sbState').textContent = 'Live';
      $('#sbDot').style.background = '';
      $('#spGw').textContent = 'online';
      $('#spTitle').textContent = 'UPLINK HEALTH';
      document.body.classList.remove('offline');
      if (window.AtlasOrb) AtlasOrb.setCaption('');
    }
  }

  setInterval(() => {
    const s = Math.floor((performance.now() - bootAt) / 1000);
    const m = Math.floor(s / 60), x = s % 60;
    $('#spUp').textContent = `${m}m ${String(x).padStart(2, '0')}s`;
  }, 1000);

  async function probe(){
    try {
      const r = await fetch('/api/health', {cache: 'no-store'});
      setOnline(r.ok);
    } catch (_) { setOnline(false); }
  }
  setInterval(probe, 20000);

  const closePop = () => { pop.hidden = true; badge.setAttribute('aria-expanded', 'false'); };
  badge.addEventListener('click', e => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    badge.setAttribute('aria-expanded', String(!pop.hidden));
  });
  document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target) && e.target !== badge) closePop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) closePop(); });

  // ── sliding nav indicator ──
  const menu = document.querySelector('.menu');
  const ind = document.createElement('span');
  ind.className = 'nav-ind';
  menu.appendChild(ind);
  function placeInd(target){
    if (!target){ ind.style.opacity = '0'; return; }
    const mr = menu.getBoundingClientRect(), br = target.getBoundingClientRect();
    ind.style.left = (br.left - mr.left) + 'px';
    ind.style.width = br.width + 'px';
    ind.style.opacity = '1';
  }
  const navbtns = menu.querySelectorAll('.navbtn');
  let active = null;
  navbtns.forEach(b => {
    b.addEventListener('click', () => { active = b; placeInd(b); });
    b.addEventListener('mouseenter', () => { if (!active) placeInd(b); });
    b.addEventListener('mouseleave', () => { if (!active) placeInd(null); });
  });
  new MutationObserver(() => {
    navbtns.forEach(b => { if (b.getAttribute('aria-expanded') === 'true') active = b; });
    if (active) placeInd(active); else placeInd(null);
  }).observe(menu, {subtree: true, attributes: true, attributeFilter: ['aria-expanded']});
  addEventListener('resize', () => { if (active) placeInd(active); });

  // ── nav overflow cue: fade the edge only while the nav can actually scroll ──
  function syncNavScroll(){
    menu.classList.toggle('nav-overflow', menu.scrollWidth - menu.clientWidth > 2);
  }
  syncNavScroll();
  menu.addEventListener('scroll', syncNavScroll, {passive: true});
  addEventListener('resize', syncNavScroll);

  renderLatency();
  probe();
})();

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

// ══════════ IIFE · morning brief home screen (real data: jobs, agents, brain, greeting) ══════════
(() => {
  'use strict';
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));
  const data = {greeting: '', date: '', agents: [], running: 0, brainCount: 0, brainDepts: [], collapsed: false};
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
    data.agents = out.agents; data.running = out.running;
    data.brainCount = out.brainCount; data.brainDepts = out.brainDepts;
    data.date = new Date().toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'});
    window.dispatchEvent(new CustomEvent('atlas-brief'));
    render();
  }

  function sentence(){
    const done = data.agents.filter(a => a.status === 'done' || a.status === 'failed').length;
    const running = data.running;
    const parts = [];
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
        ${card('--amber', 'Needs your decision', 0, '<span class="bc-empty">Nothing needs your approval right now.</span>')}
        ${card('--cyan', 'Running', data.running, runningHtml)}
        ${card('--green', 'Overnight', recent.length, overnightHtml)}
        ${card('--dept-3', 'Second brain', data.brainCount, brainHtml)}
        ${card('--dept-4', 'Business pulse', null, '<span class="bc-empty">Connect a store to see sales, orders and ad spend.</span>')}
        ${card('--dept-5', 'Family & calendar', null, '<span class="bc-empty">Connect a calendar to see the dates that matter.</span>')}
      </div></div>`;
    host.querySelectorAll('[data-brief]').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.brief;
      if (act === 'collapse'){ data.collapsed = true; render(); }
      else if (act === 'expand'){ data.collapsed = false; render(); }
      else if (act === 'play') playBrief();
    }));
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
      'Business and calendar are not connected yet. Connect them to hear the full brief.'
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
})();

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

// ══════════ IIFE · Inbox view + full-window drop + Brain linking ══════════
(() => {
  'use strict';
  const ov = document.getElementById('inboxOverlay'); if (!ov) return;
  const navBtn = document.getElementById('navInbox');
  const dropzone = document.getElementById('inbDropzone');
  const fileInput = document.getElementById('inbFileInput');
  const titleInput = document.getElementById('inbTitle');
  const deptSelect = document.getElementById('inbDept');
  const contentInput = document.getElementById('inbContent');
  const saveBtn = document.getElementById('inbSaveBtn');
  const statusMsg = document.getElementById('inbStatusMsg');
  const listEl = document.getElementById('inbList');
  const countEl = document.getElementById('inbCount');
  const pathEl = document.getElementById('inbPath');
  const autoTriageChk = document.getElementById('inbAutoTriage');
  const winDrop = document.getElementById('windowDropOverlay');
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));

  let items = [];

  const fmtSize = b => {
    if (!b && b !== 0) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  };
  const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';

  function setStatus(msg, isErr = false){
    if (!statusMsg) return;
    statusMsg.textContent = msg || '';
    statusMsg.style.color = isErr ? 'var(--red)' : 'var(--cyan)';
  }

  function updateBadge(){
    if (!navBtn) return;
    const newCount = items.filter(x => x.status === 'new').length;
    navBtn.dataset.count = newCount ? String(newCount) : '';
  }

  function render(){
    updateBadge();
    if (countEl) countEl.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    if (!items.length){
      listEl.innerHTML = '<div class="inb-empty">Drop anything here. I will read it and tell you what it is.</div>';
      return;
    }
    const showTriage = !autoTriageChk || autoTriageChk.checked;
    listEl.innerHTML = items.map(it => {
      const tr = it.triage || {};
      return `<article class="inb-card" data-id="${esc(it.id)}" data-status="${esc(it.status || 'new')}">
        <header>
          <span class="inb-kind">${esc(it.kind || 'file')}</span>
          <b class="inb-name" title="${esc(it.name)}">${esc(it.name)}</b>
          <span class="inb-st">${esc(it.status || 'new')} · ${esc(fmtSize(it.size))}</span>
        </header>
        ${it.preview ? `<div class="inb-preview"><div class="md-read md-compact">${window.AtlasMarkdown ? AtlasMarkdown.render(it.preview) : esc(it.preview)}</div></div>` : ''}
        ${showTriage && tr.action ? `<div class="inb-triage"><span>Proposed: <b>${esc(tr.team || tr.department || 'strategy')}</b> · ${esc(tr.action)}</span></div>` : ''}
        <div class="inb-actions">
          <button type="button" class="ctl run" data-inb-act="brain" data-note="${esc(it.note_id || it.id)}">Open in Brain ▸</button>
          <button type="button" class="ctl aux" data-inb-act="file" data-id="${esc(it.id)}" data-dept="${esc(tr.department || 'research-strategy')}">Approve file to ${esc(tr.department || 'Brain')}</button>
          <button type="button" class="ctl aux" data-inb-act="summarise" data-id="${esc(it.id)}">Summarise</button>
          <button type="button" class="ctl aux" data-inb-act="tasks" data-id="${esc(it.id)}">Extract tasks</button>
          <button type="button" class="ctl aux" data-inb-act="discard" data-id="${esc(it.id)}">Discard</button>
        </div>
        <div class="ag-meta"><span>Saved <b>${esc(fmtTime(it.created))}</b></span><span>Path <b>${esc(it.path || '')}</b></span></div>
      </article>`;
    }).join('');
  }

  async function refresh(){
    try {
      const r = await fetch('/api/inbox', {headers: apiHeaders(), cache: 'no-store'}).then(r => r.json());
      if (Array.isArray(r.items)) items = r.items;
      if (r.root && pathEl) pathEl.textContent = r.root;
      render();
    } catch (_) {}
  }

  async function uploadPayload(payload){
    setStatus('Saving to ~/Atlas/inbox…');
    try {
      const r = await fetch('/api/inbox', {
        method: 'POST',
        headers: apiHeaders({'content-type': 'application/json'}),
        body: JSON.stringify(payload),
      }).then(r => r.json());
      if (!r.ok){
        setStatus(r.error || 'Could not save item', true);
        return null;
      }
      setStatus(`Saved ${r.item.name} → linked into Brain as [[${r.item.note_id}]]`);
      await refresh();
      if (window.AtlasBrain && r.item.note_id){
        // reload the graph so the new inbox note really appears — pulseNode alone
        // silently no-ops when the node is not yet in the graph
        Promise.resolve(window.AtlasBrain.load?.()).then(() => window.AtlasBrain.pulseNode?.(r.item.note_id, 'inbox'));
      }
      if (window.AtlasBrief) window.AtlasBrief.refresh?.();
      return r.item;
    } catch (e) {
      setStatus('Upload failed', true);
      return null;
    }
  }

  async function handleFiles(fileList){
    if (!fileList || !fileList.length) return;
    if (ov.hidden) open();
    for (const file of fileList){
      const b64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(String(reader.result || ''));
        reader.onerror = () => rej(new Error('read error'));
        reader.readAsDataURL(file);
      }).catch(() => '');
      if (!b64) continue;
      await uploadPayload({
        name: file.name,
        data_base64: b64,
        department: deptSelect?.value || '',
      });
    }
  }

  saveBtn?.addEventListener('click', async () => {
    const name = titleInput.value.trim();
    const content = contentInput.value;
    if (!name && !content.trim()){
      setStatus('Enter a note, CSV rows, or title first', true);
      return;
    }
    const kind = /\.csv$/i.test(name) ? 'csv' : 'note';
    const saved = await uploadPayload({
      name: name || undefined,
      content,
      kind,
      department: deptSelect.value || '',
    });
    if (saved){
      titleInput.value = '';
      contentInput.value = '';
    }
  });

  dropzone?.addEventListener('click', () => fileInput?.click());
  dropzone?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); fileInput?.click(); } });
  fileInput?.addEventListener('change', () => { if (fileInput.files?.length) handleFiles(fileInput.files); fileInput.value = ''; });
  dropzone?.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', e => {
    e.preventDefault(); dropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  // Full-window drag-and-drop
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    if (winDrop) winDrop.hidden = false;
  });
  window.addEventListener('dragover', e => {
    if (winDrop && !winDrop.hidden) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && winDrop) winDrop.hidden = true;
  });
  window.addEventListener('drop', e => {
    dragDepth = 0;
    if (winDrop && !winDrop.hidden){
      e.preventDefault();
      winDrop.hidden = true;
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    }
  });

  listEl?.addEventListener('click', async e => {
    const b = e.target.closest('[data-inb-act]'); if (!b) return;
    const act = b.dataset.inbAct;
    const id = b.dataset.id;
    const it = items.find(x => x.id === id);
    if (act === 'brain'){
      const noteId = b.dataset.note;
      close();
      if (window.AtlasNav) AtlasNav.go('brain', noteId);
      return;
    }
    if (act === 'file' && id){
      await fetch('/api/inbox', {
        method: 'POST', headers: apiHeaders({'content-type': 'application/json'}),
        body: JSON.stringify({action: 'file', id, department: b.dataset.dept}),
      });
      await refresh();
      return;
    }
    if (act === 'discard' && id){
      await fetch('/api/inbox', {
        method: 'POST', headers: apiHeaders({'content-type': 'application/json'}),
        body: JSON.stringify({action: 'discard', id}),
      });
      await refresh();
      return;
    }
    if ((act === 'summarise' || act === 'tasks') && it){
      close();
      const inp = document.getElementById('input');
      if (inp){
        inp.value = act === 'summarise'
          ? `Summarise the inbox item "${it.name}" (saved at ~/Atlas/${it.path}) and propose the next decision.`
          : `Extract concrete action items from the inbox item "${it.name}" (saved at ~/Atlas/${it.path}).`;
        inp.focus();
      }
    }
  });

  autoTriageChk?.addEventListener('change', render);

  function open(){
    ov.hidden = false;
    navBtn?.setAttribute('aria-expanded', 'true');
    document.getElementById('scrim')?.click();
    refresh();
  }
  function close(){
    ov.hidden = true;
    navBtn?.setAttribute('aria-expanded', 'false');
  }

  navBtn?.addEventListener('click', () => ov.hidden ? (window.AtlasNav ? AtlasNav.go('inbox') : open()) : close());
  document.getElementById('inbClose')?.addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden){ e.stopPropagation(); close(); } }, true);

  if (window.AtlasNav) AtlasNav.views.inbox = {open, close, isOpen: () => !ov.hidden};
  window.AtlasInbox = {open, close, refresh, uploadPayload};
  refresh();
})();

// ══════════ IIFE · Jobs & Activity tab (handoff missions, /background jobs, POD & Inbox) ══════════
(() => {
  'use strict';
  const ov = document.getElementById('jobsOverlay'); if (!ov) return;
  const navBtn = document.getElementById('navJobs');
  const body = document.getElementById('jaBody');
  const sum = document.getElementById('jaSum');
  const tabs = document.getElementById('jaTabs');
  const esc = window.esc || (s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])));

  let tab = 'all', state = {running: 0, agents: [], missions: [], inbox: [], pod: []}, timer = null;

  const dur = s => {
    if (s == null) return '—';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`;
  };
  const clock = t => t ? new Date(t * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '—';

  function updateBadge(){
    if (!navBtn) return;
    const n = state.running || 0;
    navBtn.dataset.count = n ? String(n) : '';
  }

  function renderJobCard(a){
    const running = a.status === 'running' || a.status === 'stalled';
    return `<article class="ag-card st-${esc(a.status || 'done')}" data-id="${esc(a.id || '')}">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(a.name || a.mission || 'Mission')}</b>
        <span class="ag-tag">${esc(a.kind || 'handoff')}</span>
        <span class="ag-status">${esc(a.status || 'done')}</span></header>
      <div class="ag-brief">${esc((a.brief || a.mission || '').slice(0, 240))}</div>
      ${running && a.step ? `<div class="ag-step"><span class="ag-k">Live step</span><span class="ag-v">${esc(a.step)}</span></div>` : ''}
      ${!running && a.result ? `<div class="ag-result"><span class="ag-k">Outcome</span><div class="ag-rtext">${esc(a.result)}</div></div>` : ''}
      <div class="ag-meta"><span>Started <b>${esc(clock(a.started || a.at))}</b></span>
        ${a.elapsed != null ? `<span>Duration <b>${esc(dur(a.elapsed))}</b></span>` : ''}
        <span class="ag-id">${esc(a.id || '')}</span></div>
    </article>`;
  }

  function renderInboxCard(it){
    const tr = it.triage || {};
    return `<article class="ag-card st-done" data-id="${esc(it.id)}">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(it.name)}</b>
        <span class="ag-tag">inbox · ${esc(it.kind || 'file')}</span>
        <span class="ag-status">${esc(it.status || 'new')}</span></header>
      ${it.preview ? `<div class="ag-brief md-read md-compact">${window.AtlasMarkdown ? AtlasMarkdown.render(it.preview.slice(0, 200)) : esc(it.preview.slice(0, 200))}</div>` : ''}
      <div class="ag-meta"><span>Saved <b>${esc(clock(it.created))}</b></span>
        <span>Dept <b>${esc(tr.department || '—')}</b></span>
        <button type="button" class="ag-more" data-open-brain="${esc(it.note_id || it.id)}">Open in Brain ▸</button></div>
    </article>`;
  }

  function renderPodCard(p){
    return `<article class="ag-card st-done">
      <header><span class="ag-dot"></span><b class="ag-name">${esc(p.name || p.id || 'POD item')}</b>
        <span class="ag-tag">POD</span>
        <span class="ag-status">${esc(p.verdict || p.path || 'note')}</span></header>
      <div class="ag-brief md-read md-compact">${window.AtlasMarkdown ? AtlasMarkdown.render((p.preview || p.summary || '').slice(0, 240)) : esc((p.preview || p.summary || '').slice(0, 240))}</div>
      <div class="ag-meta">
        ${p.score != null ? `<span>Score <b>${esc(p.score)}/100</b></span>` : ''}
        <button type="button" class="ag-more" data-open-brain="${esc(p.id || 'pod-idea-queue')}">Open in Brain ▸</button>
      </div>
    </article>`;
  }

  function render(){
    updateBadge();
    const agents = state.agents || [];
    const inb = state.inbox || [];
    const pod = state.pod || [];
    if (sum) sum.textContent = `${state.running || 0} running · ${agents.length} missions · ${inb.length} inbox · ${pod.length} POD`;

    let html = '';
    if (tab === 'all' || tab === 'jobs'){
      const running = agents.filter(a => a.status === 'running' || a.status === 'stalled');
      const done = agents.filter(a => !(a.status === 'running' || a.status === 'stalled'));
      html += `<div class="ag-sec">Running Handoff &amp; Background Missions (${running.length})</div>`;
      html += running.length ? `<div class="ag-grid">${running.map(renderJobCard).join('')}</div>` : '<div class="pal-empty">No missions running right now.</div>';
      html += `<div class="ag-sec">Completed &amp; Recent Missions (${done.length})</div>`;
      html += done.length ? `<div class="ag-grid">${done.map(renderJobCard).join('')}</div>` : '<div class="pal-empty">No completed missions recorded yet.</div>';
    }
    if (tab === 'all' || tab === 'pod'){
      html += `<div class="ag-sec">Recent Inbox Drops (${inb.length})</div>`;
      html += inb.length ? `<div class="ag-grid">${inb.map(renderInboxCard).join('')}</div>` : '<div class="pal-empty">No items in ~/Atlas/inbox yet.</div>';
      html += `<div class="ag-sec">POD Scorecard &amp; Reviews (${pod.length})</div>`;
      html += pod.length ? `<div class="ag-grid">${pod.map(renderPodCard).join('')}</div>` : '<div class="pal-empty">No POD notes found yet.</div>';
    }
    body.innerHTML = html;
  }

  async function refresh(){
    try {
      const r = await fetch('/api/activity', {headers: apiHeaders(), cache: 'no-store'}).then(r => r.json());
      if (r && Array.isArray(r.agents)){
        state = r;
        render();
      }
    } catch (_) {}
  }

  tabs?.addEventListener('click', e => {
    const b = e.target.closest('[data-jatab]'); if (!b) return;
    tab = b.dataset.jatab;
    tabs.querySelectorAll('[data-jatab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    render();
  });

  body?.addEventListener('click', e => {
    const b = e.target.closest('[data-open-brain]'); if (!b) return;
    const noteId = b.dataset.openBrain;
    close();
    if (window.AtlasNav) AtlasNav.go('brain', noteId);
  });

  function open(){
    ov.hidden = false;
    navBtn?.setAttribute('aria-expanded', 'true');
    document.getElementById('scrim')?.click();
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!ov.hidden && !document.hidden) refresh(); }, 3500);
  }
  function close(){
    ov.hidden = true;
    navBtn?.setAttribute('aria-expanded', 'false');
    clearInterval(timer); timer = null;
  }

  navBtn?.addEventListener('click', () => ov.hidden ? (window.AtlasNav ? AtlasNav.go('jobs') : open()) : close());
  document.getElementById('jaClose')?.addEventListener('click', close);
  document.getElementById('jaRefresh')?.addEventListener('click', refresh);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden){ e.stopPropagation(); close(); } }, true);

  if (window.AtlasNav) AtlasNav.views.jobs = {open, close, isOpen: () => !ov.hidden};
  window.AtlasJobs = {open, close, refresh};
  refresh();
})();

// ══════════ IIFE · Sentence-level streaming TTS & acknowledgement event wiring ══════════
(() => {
  'use strict';
  let streamedThisRun = false;

  function enqueueSpeech(sentence){
    const clean = cleanForSpeech(sentence);
    if (!clean || muted || !speakThisRun) return;
    streamedThisRun = true;
    speakDone = say(clean);
  }

  const prevHandle = handle;
  handle = ev => {
    if (ev.t === 'ack' || ev.t === 'acknowledgement'){
      const msg = (ev.text || ev.message || '').trim();
      if (msg){
        log('voice', 'ACK', msg);
        if (window.AtlasOrb) AtlasOrb.setCaption(msg, false, 'ACK');
        enqueueSpeech(msg);
      }
      return;
    }
    if (ev.t === 'sentence' || ev.t === 'tts_chunk'){
      const s = (ev.text || '').trim();
      if (s) enqueueSpeech(s);
      return;
    }
    if (ev.t === 'complete' && streamedThisRun){
      // Avoid speaking the full answer a second time if sentences were already streamed
      const savedSpeak = speakThisRun;
      speakThisRun = false;
      try {
        return prevHandle(ev);
      } finally {
        speakThisRun = savedSpeak;
        speakDone = ttsChain;
        streamedThisRun = false;
      }
    }
    if (ev.t === 'error'){
      streamedThisRun = false;
    }
    return prevHandle(ev);
  };
})();

// ══════════ reading toolbar for the Brain note panel ══════════
// Font size (persisted), focus / reading mode, fullscreen, copy and download.
// Appended as its own IIFE so the transmit / voice logic is untouched.
(() => {
  const panel = document.getElementById('brainOverlay');
  const noteEl = document.getElementById('brText');
  if (!panel || !noteEl) return;

  // ── A- / A+ text size, remembered across sessions ──
  const KEY = 'jarvis.mdScale';
  const MIN = 0.8, MAX = 1.9, STEP = 0.1;
  const clamp = v => Math.max(MIN, Math.min(MAX, Math.round(v * 100) / 100));
  let scale = 1;
  try { const s = parseFloat(localStorage.getItem(KEY)); if (Number.isFinite(s)) scale = clamp(s); } catch (_) {}
  const applyScale = () => {
    noteEl.style.setProperty('--md-scale', String(scale));
    try { localStorage.setItem(KEY, String(scale)); } catch (_) {}
  };
  applyScale();
  const dec = document.getElementById('brFontDec');
  const inc = document.getElementById('brFontInc');
  if (dec) dec.addEventListener('click', () => { scale = clamp(scale - STEP); applyScale(); });
  if (inc) inc.addEventListener('click', () => { scale = clamp(scale + STEP); applyScale(); });

  // ── focus / reading mode ──
  const focusBtn = document.getElementById('brFocus');
  const setFocus = on => {
    document.body.classList.toggle('reading-focus', on);
    if (focusBtn) focusBtn.setAttribute('aria-pressed', String(on));
  };
  if (focusBtn) focusBtn.addEventListener('click', () => setFocus(!document.body.classList.contains('reading-focus')));

  // ── fullscreen ──
  const fullBtn = document.getElementById('brFull');
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  const exitFs = () => { const f = document.exitFullscreen || document.webkitExitFullscreen; if (f) f.call(document); };
  if (fullBtn) fullBtn.addEventListener('click', () => {
    const target = document.querySelector('.brain-note') || noteEl;
    if (fsEl()) { exitFs(); return; }
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (req) { const p = req.call(target); if (p && p.catch) p.catch(() => {}); }
  });
  const onFs = () => { if (fullBtn) fullBtn.setAttribute('aria-pressed', String(!!fsEl())); };
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);

  const flash = (el, text) => {
    if (!el) return;
    const old = el.textContent; el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 1200);
  };

  // ── copy the raw markdown ──
  const copyBtn = document.getElementById('brCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const raw = noteEl._raw || '';
    if (!raw) { flash(copyBtn, 'Empty'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(raw);
      } else {
        const ta = document.createElement('textarea');
        ta.value = raw; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      flash(copyBtn, 'Copied');
    } catch (_) { flash(copyBtn, 'Copy failed'); }
  });

  // ── download the note as a .md file ──
  const dlBtn = document.getElementById('brDownload');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    const raw = noteEl._raw || '';
    if (!raw) return;
    const id = String(noteEl._noteId || 'note').replace(/[^A-Za-z0-9._-]+/g, '-') || 'note';
    const url = URL.createObjectURL(new Blob([raw], {type: 'text/markdown;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url; a.download = id + '.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // leaving the brain clears reading mode so the graph is never left dimmed
  new MutationObserver(() => {
    if (panel.hidden) { setFocus(false); if (fsEl()) exitFs(); }
  }).observe(panel, {attributes: true, attributeFilter: ['hidden']});
})();
