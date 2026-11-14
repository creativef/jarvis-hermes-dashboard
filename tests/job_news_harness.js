// Runs the shipped job-news rule from ui/app.js: news never talks over you mid-sentence.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const code = src.slice(src.indexOf('// ── job news ──'), src.indexOf('// poll for finished'));
const said = [];
const api = new Function('said', `
  var convo = false, spoke = false, suppress = false, recorder = null;
  function say(t){ said.push(t); }
  ${code}
  return {jobNews, tellJobNews, set(v){ convo = v.convo; spoke = v.spoke; suppress = v.suppress; recorder = v.recorder; }};`)(said);
let ok = true;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); ok = ok && c; };
const rec = {state: 'recording'};
api.jobNews.push('Mission complete. Prices compared.');
api.set({convo: true, spoke: true, suppress: false, recorder: rec});
api.tellJobNews();
check(said.length === 0 && api.jobNews.length === 1, 'news is held while you are mid-sentence');
api.set({convo: true, spoke: false, suppress: false, recorder: rec});
api.tellJobNews();
check(said.length === 1 && api.jobNews.length === 0, 'news is told once you have stopped talking');
api.jobNews.push('That job failed.');
api.set({convo: false, spoke: true, suppress: false, recorder: null});
api.tellJobNews();
check(said.length === 2, 'mic closed: news is told at once');
api.jobNews.push('Another one.');
api.set({convo: true, spoke: true, suppress: true, recorder: rec});
api.tellJobNews();
check(said.length === 3, 'mic already deaf (Atlas is working): nothing of yours to lose');
process.exit(ok ? 0 : 1);
