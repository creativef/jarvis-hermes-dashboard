const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const pick = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const code = pick('function cleanForSpeech', '/* ══════════ continuous voice') + pick('// ── voice out ──', '// ── start / stop the whole conversation ──');
// fakes
let plays = [], begun = 0, fetches = 0, hold = null;
class FakeAudio { constructor(u){ this.u=u; this.paused=true; this.starts=0; this.currentTime=0; plays.push(this); }
  play(){ this.paused=false; this.starts++; return Promise.resolve(); }
  pause(){ if (this.paused) return; this.paused=true; this.onpause && this.onpause(); }
  end(){ this.paused=true; this.onended && this.onended(); } }
const env = `
  var document = {body:{classList:{add(){},remove(){},contains(){return false}}}};
  var RT = {tts:true}, speechSynth = null, suppress = false, convo = false, recorder = null, recognition = null, micStream = {};
  var Audio = FakeAudio, URL = {createObjectURL:()=> 'blob:', revokeObjectURL(){}};
  var apiHeaders = h => h, fetch = () => incFetch();
  function beginTurn(){ begun++; } function startBrowserRecognition(){}
  var turnT = {}, markT = () => {}, inTransmit = 0;
`;
const tick = () => new Promise(r => setTimeout(r, 5));
const run = new Function('FakeAudio','plays','getBegun','incBegun','incFetch', env.replace('begun++','incBegun()') + code + `
  return {say, stopSpeech, pauseSpeech, resumeSpeech, setConvo(v){convo=v}, getSuppress(){return suppress}, setMuted(v){muted=v}};`);
const res = {ok:true, blob:()=>Promise.resolve('b')};
let api = run(FakeAudio, plays, () => begun, () => begun++, () => { fetches++;
  return hold ? new Promise(r => { const h = hold; hold = null; h.release = () => r(res); }) : Promise.resolve(res); });
(async () => {
  let ok = true; const check = (c, m) => { console.log((c?'PASS ':'FAIL ') + m); ok = ok && c; };
  // 1. pausing the playing line must not jam the queue
  const p1 = api.say('First line.'); api.say('Second line.'); const last = api.say('Third line.');
  await tick(); check(plays.length === 1, 'first line playing');
  check(fetches === 3, 'next lines are synthesised while the first plays');
  plays[0].pause();                                   // e.g. mute / call mode / old bug
  await tick(); check(plays.length === 2, 'queue moves on after a pause');
  // 2. stopSpeech silences and drops the rest
  api.stopSpeech(); let done = false; last.then(() => done = true);
  await tick(); check(done && plays.length === 2, 'stopSpeech empties the queue and resolves');
  // 3. speech after a stop still works
  api.say('Later line.'); await tick(); check(plays.length === 3, 'new speech plays after a stop');
  plays[2].end(); await tick();
  // 4. announcement while the mic is listening: mic deafened, then re-opened
  api.setConvo(true); const b0 = begun;
  api.say('Mission complete.'); await tick();
  check(api.getSuppress() === true, 'mic deaf while announcing');
  plays[3].end(); await tick();
  check(api.getSuppress() === false && begun === b0 + 1, 'mic re-opens after announcement');
  // 5. stop while the first line's audio is still being made: it never plays,
  //    and the lines queued behind it are never synthesised at all
  const f0 = fetches, p0 = plays.length, gate = hold = {};
  api.say('Slow line.'); api.say('Queued two.'); api.say('Queued three.');
  await tick(); api.stopSpeech(); gate.release(); await tick();
  check(plays.length === p0, 'stopped line never starts playing');
  check(fetches === f0 + 1, 'lines queued before a stop are never synthesised');
  // 6b. pause keeps the line and the queue; resume replays the line, then carries on
  api.setConvo(false);
  const pp = plays.length; api.say('Point one.'); api.say('Point two.'); await tick();
  const held = plays[pp]; api.pauseSpeech(); await tick();
  check(held.paused && plays.length === pp + 1, 'pause holds the current line and the queue');
  api.resumeSpeech(); await tick();
  check(held.starts === 2 && !held.paused, 'resume replays the interrupted line');
  held.end(); await tick();
  check(plays.length === pp + 2, 'the rest of the answer follows after resuming');
  plays[pp + 1].end(); await tick();
  // 6c. paused between lines: the next line waits; stop while paused never jams
  const pq = plays.length; api.say('Held line.'); api.pauseSpeech(); await tick();
  check(plays.length === pq, 'a line ready while paused waits for resume');
  let freed = false; api.say('After.').then(() => freed = true); api.stopSpeech(); await tick();
  check(freed && plays.length === pq, 'stopping while paused frees the queue');

  // 7. a cough or "hmm" is noise; real one-word answers are kept
  const FILLER = eval('(' + src.match(/^const FILLER = (.*);$/m)[1] + ')');
  check(['Hmm.', 'Uh.', 'Mm.', 'Um...', '.', ''].every(t => FILLER.test(t)), 'filler transcripts are ignored');
  check(!['Yes.', 'No.', 'Okay.', 'Yeah', 'Hmm, what time is it?', 'Ah, open the brain'].some(t => FILLER.test(t)), 'real words are kept');
  // 8. barge-in: his own echo never triggers it, your louder voice does,
  //    and a false trigger makes it less sensitive
  const bargeSrc = pick('// ── barge-in: talk over Atlas', 'function beginTurn(){');
  const B = new Function('FILLER', `
    let clock = 0, speaking = true, amp = 0, stops = 0, aborts = 0, pauses = 0, turns = 0;
    var currentLine = 'Your hoodie sales are up.', suppress = true;
    var pauseSpeech = () => { pauses++; speaking = false; }, beginTurn = () => { turns++; };
    var performance = {now: () => clock}, localStorage = {getItem: () => null};
    var document = {body: {classList: {contains: c => c === 'speaking' && speaking}}};
    var window = {}, convo = true, running = true, activeController = {abort(){ aborts++; }};
    var vdata = new Uint8Array(64), analyser = {getByteTimeDomainData(d){ d.fill(128 + Math.round(amp * 127)); }};
    var log = () => {}, apiHeaders = h => h, fetch = () => Promise.resolve(), stopSpeech = () => { stops++; };
    ${bargeSrc}
    return {
      run(a, ms){ amp = a; for (let t = 0; t < ms; t += 40){ clock += 40; bargeCheck(); } },
      stops: () => stops, aborts: () => aborts, pauses: () => pauses, turns: () => turns,
      barged: () => bargedTurn, factor: () => bargeFactor, cut: () => interruptedLine,
      result: r => bargeResult(r), kind: t => interjectionKind(t), speak(){ speaking = true; },
    };`)(FILLER);
  B.run(0.03, 600);  B.run(0.03, 2000);
  check(B.stops() === 0, 'his own echo never interrupts him');
  B.run(0.12, 400);
  check(B.pauses() === 1 && B.turns() === 1 && B.barged(), 'talking over him pauses him and starts listening');
  check(B.stops() === 0 && B.aborts() === 0, 'the answer is not thrown away or cancelled');
  check(B.cut() === 'Your hoodie sales are up.', 'remembers which line was interrupted');
  B.result(false);
  check(B.factor() > 1.8 && !B.barged(), 'a false interruption makes barge-in less sensitive');
  const K = {'': 'resume', 'Hmm.': 'resume', 'Go on.': 'resume', 'Sorry, go ahead': 'resume',
             'Wait.': 'hold', 'Hold on a sec': 'hold', 'Stop.': 'stop', 'Never mind': 'stop',
             'Wait, what about the mugs?': 'say', 'Also check Etsy.': 'say', 'Stop the ads on Etsy': 'say'};
  const wrong = Object.entries(K).filter(([t, k]) => B.kind(t) !== k).map(([t, k]) => `${t}→${B.kind(t)} (want ${k})`);
  check(!wrong.length, 'what you say decides: resume / hold / stop / answer ' + wrong.join(', '));
  process.exit(ok ? 0 : 1);
})();
