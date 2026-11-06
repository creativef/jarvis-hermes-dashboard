// Drives ui/greeting.js with fakes: no speech on load, only on a real gesture, and only
// when the server (which decides once a day for every tab) says so.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

let fails = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const tick = () => new Promise(r => setTimeout(r, 8));
const SHOWN = 'Good morning, Mr Thompson. What are we working on today?';
const FRESH = 'Good evening, Mr Thompson. Ready when you are.';

function makeEnv(opts) {
  opts = opts || {};
  const state = { said: [], asked: [], timers: [], handlers: [], h3: { textContent: '' } };
  const document = {
    addEventListener: (t, fn) => state.handlers.push({ t, fn }),
    removeEventListener: (t, fn) => {
      const i = state.handlers.findIndex(h => h.t === t && h.fn === fn);
      if (i >= 0) state.handlers.splice(i, 1);
    },
    querySelector: sel => (sel === '.welcome h3' ? state.h3 : null),
  };
  const fetch = url => {
    if (url.indexOf('claim=1') >= 0) state.asked.push(url);
    const claim = url.indexOf('claim=1') >= 0;
    const body = { text: claim ? FRESH : SHOWN, enabled: opts.enabled !== false };
    if (claim) body.speak = opts.speak !== false && url.indexOf('busy=1') < 0;
    return Promise.resolve({ json: () => Promise.resolve(body) });
  };
  const window = { atlasBusy: () => !!opts.busy };
  const setTimeout = fn => { state.timers.push(fn); };
  const run = new Function('document', 'fetch', 'apiHeaders', '$', 'log', 'say', 'window', 'setTimeout', src);
  run(document, fetch, h => h, () => ({ addEventListener() {}, value: '', checked: false }),
      () => {}, t => { state.said.push(t); return Promise.resolve(); }, window, setTimeout);
  return {
    state, window,
    boot: async () => { state.timers.splice(0).forEach(f => f()); await tick(); await tick(); },
    fire: async (type, extra) => {
      state.handlers.filter(h => h.t === type).forEach(h => h.fn(Object.assign({ type }, extra || {})));
      await tick(); await tick();
    },
  };
}

(async () => {
  // 1. loading the page never speaks; the text is shown
  const a = makeEnv({});
  await a.boot();
  check(a.state.said.length === 0, 'no greeting is spoken on load');
  check(a.state.h3.textContent === SHOWN, 'the greeting text is shown on screen');
  check(a.state.asked.length === 0, 'loading the page does not use up the day');
  check(typeof a.window.__greetNow === 'function', 'the mic gate can still await __greetNow');

  // 2. the first gesture asks the server, and speaks freshly built text
  await a.fire('pointerdown');
  check(a.state.asked.length === 1, 'the first gesture asks the server once');
  check(a.state.said.length === 1 && a.state.said[0] === FRESH, 'it speaks the fresh text, not the one from page load');
  await a.fire('pointerdown');
  check(a.state.asked.length === 1 && a.state.said.length === 1, 'a second gesture does nothing');

  // 3. the server says no (another tab, a restart, already talked today): silent
  const b = makeEnv({ speak: false });
  await b.boot(); await b.fire('pointerdown');
  check(b.state.said.length === 0, 'silent when the server says the day is used up');

  // 4. the bug: a click while Atlas is busy must not speak, and tells the server so
  const c = makeEnv({ busy: true });
  await c.boot(); await c.fire('pointerdown');
  check(c.state.said.length === 0, 'a click while Atlas is busy stays silent');
  check(/busy=1/.test(c.state.asked[0] || ''), 'and uses up the day (busy=1)');

  // 5. typing into a field means the day's work has started
  const d = makeEnv({});
  await d.boot(); await d.fire('keydown', { code: 'KeyH', target: { tagName: 'TEXTAREA' } });
  check(d.state.said.length === 0 && /busy=1/.test(d.state.asked[0] || ''), 'typing a message does not trigger it');

  // 6. modified keys don't count; a plain key does
  const e = makeEnv({});
  await e.boot(); await e.fire('keydown', { metaKey: true });
  check(e.state.said.length === 0 && e.state.asked.length === 0, 'cmd/ctrl keypresses do not trigger the greeting');
  await e.fire('keydown', { code: 'KeyA', target: { tagName: 'BODY' } });
  check(e.state.said.length === 1, 'a plain keypress outside a field does');

  // 7. Space belongs to the mic gate
  const f = makeEnv({});
  await f.boot(); await f.fire('keydown', { code: 'Space' });
  check(f.state.said.length === 0 && f.state.asked.length === 0, 'Space does not speak the greeting');
  await f.window.__greetNow(); await tick();
  check(f.state.said.length === 1, 'the mic gate can still play it through __greetNow');

  // 8. switched off in settings
  const g = makeEnv({ enabled: false });
  await g.boot(); await g.fire('pointerdown');
  check(g.state.said.length === 0 && g.state.asked.length === 0, 'a disabled greeting is never asked for or spoken');

  console.log(fails ? 'FAILED (' + fails + ')' : 'OK');
  process.exit(fails ? 1 : 0);
})();
