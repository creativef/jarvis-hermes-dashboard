/* Runs before first paint (the page's CSP forbids inline scripts): applies the saved theme, mode
   (light/dark/auto) and layout so there is no flash of the wrong look.
   #theme=terminal&mode=light&layout=focus in the URL overrides the saved choice for that visit only. */
try {
  var d = document.documentElement, S = localStorage;
  // ids from the first colour-only theme set map onto the new themes
  var OLD = {midnight:['atlas','dark'], ember:['clay','dark'], aurora:['aurora','dark'], nebula:['aurora','dark'],
             paper:['folio','light'], sky:['atlas','light'], sand:['clay','light'], mint:['aurora','light']};
  var T = S.getItem('jarvis.theme'), M = S.getItem('jarvis.mode'), L = S.getItem('jarvis.layout');
  if (T && OLD[T]) { if (!M) M = OLD[T][1]; T = OLD[T][0]; S.setItem('jarvis.theme', T); S.setItem('jarvis.mode', M); }
  var h = location.hash, a = /theme=([a-z]+)/.exec(h), b = /layout=([a-z]+)/.exec(h), c = /mode=([a-z]+)/.exec(h);
  if (a) T = a[1]; if (b) L = b[1]; if (c) M = c[1];
  if (!/^(atlas|terminal|folio|brutal|aurora|blueprint|clay)$/.test(T || '')) T = 'atlas';
  if (M !== 'light' && M !== 'auto') M = 'dark';
  d.dataset.theme = T;
  d.dataset.pref = M || 'dark';                      // dark | light | auto
  d.dataset.mode = M === 'light' || (M === 'auto' && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  if (L) d.dataset.layout = L;
} catch (e) {}
