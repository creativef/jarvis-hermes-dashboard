const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const pick = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const code = pick('function cleanForSpeech', '/* ══════════ continuous voice') + pick('// ── voice out ──', '// ── start / stop the whole conversation ──');
// fakes
let plays = [], begun = 0, fetches = 0, hold = null;
class FakeAudio { constructor(u){ this.u=u; plays.push(this); }
  play(){ return Promise.resolve(); } pause(){ this.paused=true; this.onpause && this.onpause(); }
  end(){ this.onended && this.onended(); } }
const env = `
  var document = {body:{classList:{add(){},remove(){},contains(){return false}}}};
  var RT = {tts:true}, speechSynth = null, suppress = false, convo = false, recorder = null, recognition = null, micStream = {};
  var Audio = FakeAudio, URL = {createObjectURL:()=> 'blob:', revokeObjectURL(){}};
  var apiHeaders = h => h, fetch = () => incFetch();
  function beginTurn(){ begun++; } function startBrowserRecognition(){}
`;
const tick = () => new Promise(r => setTimeout(r, 5));
const run = new Function('FakeAudio','plays','getBegun','incBegun','incFetch', env.replace('begun++','incBegun()') + code + `
  return {say, stopSpeech, setConvo(v){convo=v}, getSuppress(){return suppress}, setMuted(v){muted=v}};`);
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
  // 7. a cough or "hmm" is noise; real one-word answers are kept
  const FILLER = eval('(' + src.match(/^const FILLER = (.*);$/m)[1] + ')');
  check(['Hmm.', 'Uh.', 'Mm.', 'Um...', '.', ''].every(t => FILLER.test(t)), 'filler transcripts are ignored');
  check(!['Yes.', 'No.', 'Okay.', 'Yeah', 'Hmm, what time is it?', 'Ah, open the brain'].some(t => FILLER.test(t)), 'real words are kept');
  process.exit(ok ? 0 : 1);
})();
