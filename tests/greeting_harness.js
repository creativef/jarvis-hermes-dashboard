// Drives ui/greeting.js with fakes: no speech on load, once per day, only on a real gesture.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

let fails = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const tick = () => new Promise(r => setTimeout(r, 8));
const TEXT = 'Good afternoon, Mr Thompson. What are we working on?';

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const state = { said: [], timers: [], handlers: [], h3: { textContent: '' } };
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const document = {
    addEventListener: (t, fn) => state.handlers.push({ t, fn }),
    removeEventListener: (t, fn) => {
      const i = state.handlers.findIndex(h => h.t === t && h.fn === fn);
      if (i >= 0) state.handlers.splice(i, 1);
    },
    querySelector: sel => (sel === '.welcome h3' ? state.h3 : null),
  };
  const fetch = () => Promise.resolve({
    json: () => Promise.resolve({
      text: TEXT, enabled: opts.enabled !== false, boot_id: opts.boot_id || 'aaaa1111',
    }),
  });
  const window = {};
  const setTimeout = fn => { state.timers.push(fn); };
  const run = new Function(
    'document', 'localStorage', 'fetch', 'apiHeaders', '$', 'log', 'say', 'window', 'setTimeout', 'navigator',
    src,
  );
  run(document, localStorage, fetch, h => h, () => ({ addEventListener() {}, value: '', checked: false }),
      () => {}, t => { state.said.push(t); return Promise.resolve(); }, window, setTimeout,
      {});                                    // navigator deliberately has no userActivation
  return {
    state, store, window,
    flush: () => state.timers.splice(0).forEach(f => f()),
    fire: (type, extra) => {
      const hits = state.handlers.filter(h => h.t === type);   // copy: the handler removes itself
      hits.forEach(h => h.fn(Object.assign({ type }, extra || {})));
    },
  };
}

(async () => {
  // 1. loading the page must never speak on its own
  const a = makeEnv({});
  a.flush(); await tick(); await tick();
  check(a.state.said.length === 0, 'no greeting is spoken on load');
  check((a.state.h3.textContent || '').indexOf('Good') === 0, 'the greeting text is still shown on screen');
  check(typeof a.window.__greetNow === 'function', 'the mic gate can still await __greetNow');

  // 2. the first real gesture speaks it, exactly once
  a.fire('pointerdown');
  await tick();
  check(a.state.said.length === 1 && a.state.said[0] === TEXT, 'the first gesture speaks the greeting once');
  check(!!a.store['jarvis.greeted'], 'the day is marked once it has been spoken');
  a.fire('pointerdown'); await tick();
  check(a.state.said.length === 1, 'a second gesture does not repeat it');

  // 3. the bug: a fresh server launch (new boot_id) on the same day must stay silent
  const b = makeEnv({ store: a.store, boot_id: 'bbbb2222' });
  b.flush(); await tick(); await tick();
  b.fire('pointerdown'); await tick();
  check(b.state.said.length === 0, 'a restart with a new boot_id does not greet again the same day');

  // 4. a modified-key press is not a greeting gesture
  const c = makeEnv({});
  c.flush(); await tick(); await tick();
  c.fire('keydown', { metaKey: true });
  await tick();
  check(c.state.said.length === 0, 'cmd/ctrl keypresses do not trigger the greeting');
  c.fire('keydown', { code: 'KeyA' }); await tick();
  check(c.state.said.length === 1, 'a plain keypress does');
  c.fire('keydown', { metaKey: true }); await tick();
  check(c.state.said.length === 1, 'a modified keypress afterwards stays silent');

  // 5. Space belongs to the mic gate, not the greeting
  const d = makeEnv({});
  d.flush(); await tick(); await tick();
  d.fire('keydown', { code: 'Space' }); await tick();
  check(d.state.said.length === 0, 'Space does not speak the greeting');
  check(typeof d.window.__greetNow === 'function', 'Space can still reach it through __greetNow');

  // 6. greeting switched off in settings
  const e = makeEnv({ enabled: false });
  e.flush(); await tick(); await tick();
  e.fire('pointerdown'); await tick();
  check(e.state.said.length === 0, 'a disabled greeting is never spoken');
  check(!e.store['jarvis.greeted'], 'a disabled greeting does not mark the day');

  console.log(fails ? 'FAILED (' + fails + ')' : 'OK');
  process.exit(fails ? 1 : 0);
})();