/* Atlas · Departments view — three switchable layouts (grid · sidebar · orbit).
   Self-contained: builds its own overlay and nav button; styles live in departments.css. */
(() => {
  'use strict';
  // slug, name, remit, colour variable, sub-teams [slug, name, remit] — mirrors ~/Atlas/departments (team.py list)
  const D = [
    ['research-strategy', 'Research & Strategy', 'Find out what is true about markets, products, competitors and opportunities, then turn it into recommendations.', '--cyan', [
      ['competitor-intel', 'Competitor Intelligence', 'Who else is selling, what works for them, gaps to exploit.'],
      ['market-research', 'Market Research', 'Demand, niches, audiences, trends.'],
      ['product-research', 'Product Research', 'What to make and sell: ideas, validation, pricing signals.'],
      ['strategy', 'Strategy', 'Positioning, roadmap, priorities, opportunity scoring.']]],
    ['design-content', 'Design & Content', 'Create the products and everything creative around them: designs, copy, video, images, ads and content.', '--violet', [
      ['ads-creative', 'Ad Creative', 'Ad concepts, copy and visuals ready to run (placement belongs to Marketing).'],
      ['copywriting', 'Copywriting', 'Product pages, emails, hooks, scripts, slogans.'],
      ['images-graphics', 'Images & Graphics', 'Brand visuals, thumbnails, product imagery.'],
      ['long-form', 'Long-form Content', 'Articles, guides, newsletters, written series.'],
      ['pod-design', 'Print on Demand Design', 'T-shirts, mugs and other products: concepts, layouts, mockups.'],
      ['product-development', 'Product Development', 'Turning researched ideas into finished, sellable products.'],
      ['short-form', 'Short-form Content', 'Posts, reels, captions, short clips.'],
      ['video', 'Video', 'Promo, explainer and short-form video.']]],
    ['marketing', 'Marketing', 'Get the right audience to the right offer: channels, campaigns, funnels and measurement.', '--amber', [
      ['analytics', 'Analytics', 'What is working, what is not, and what to do next.'],
      ['email-funnels', 'Email & Funnels', 'Lists, sequences, landing pages, conversion.'],
      ['paid-advertising', 'Paid Advertising', 'Campaign setup, targeting, budgets (advice only), testing.'],
      ['social-media', 'Social Media', 'Calendar, posting plan, community, platform tactics.']]],
    ['business-operations', 'Business & Operations', 'Keep the business running: operations, legal housekeeping, customers and the tools that automate it.', '--green', [
      ['customer-support', 'Customer Support', 'Replies, FAQs, refunds, feedback loops.'],
      ['legal-compliance', 'Legal & Compliance', 'Contracts, trademarks, policies, platform rules. Flags risk plainly.'],
      ['operations', 'Operations', 'Suppliers, fulfilment, workflows, checklists.'],
      ['tech-automation', 'Tech & Automation', 'Stores, integrations, scripts, dashboards.']]],
    ['finance', 'Finance', 'Know the numbers: budgets, pricing, revenue and costs, tax and cash flow. Advise only; never move money.', '--red', [
      ['bookkeeping-tax', 'Bookkeeping & Tax', 'Records, categories, deadlines, what to ask the accountant.'],
      ['budgeting', 'Budgeting & Cash Flow', 'Budgets, forecasts, runway.'],
      ['pricing', 'Pricing & Margins', 'Unit economics, price tests, margins.']]],
  ];
  const VIEWS = [['grid', 'Grid'], ['sidebar', 'Sidebar'], ['orbit', 'Orbit']];
  const KEY = 'jarvis.deptview';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const byId = Object.fromEntries(D.map(d => [d[0], d]));
  let view = 'grid', sel = {dept: D[0][0], team: null};
  try { const v = localStorage.getItem(KEY); if (VIEWS.some(x => x[0] === v)) view = v; } catch (_) {}
  const h = /deptview=([a-z]+)/.exec(location.hash); if (h && VIEWS.some(x => x[0] === h[1])) view = h[1];

  // ── shell ──
  const ov = document.createElement('div');
  ov.id = 'deptOverlay'; ov.className = 'dept-overlay'; ov.hidden = true;
  ov.innerHTML = `<div class="dept-panel glass" role="dialog" aria-label="Departments">
    <div class="rhead"><span>Departments</span>
      <div class="dept-switch" role="group" aria-label="Layout">${VIEWS.map(([id, n]) =>
        `<button type="button" data-view="${id}"><i class="dv-ico dv-${id}"></i>${n}</button>`).join('')}</div>
      <button class="ctl aux" id="deptClose" aria-label="Close departments">✕</button></div>
    <div class="dept-body" id="deptBody"></div></div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector('#deptBody');

  const state = id => {                       // live status borrowed from the department rail
    const el = document.querySelectorAll('#teamRail .tr-item')[D.findIndex(d => d[0] === id)];   // rail order matches D
    return el ? (el.classList.contains('working') ? 'working' : el.classList.contains('done') ? 'done' : '') : '';
  };
  const dot = id => `<span class="dp-state ${state(id)}" title="${state(id) || 'idle'}"></span>`;
  const cv = d => `style="--c:var(${d[3]})"`;

  function brief(slug, name){
    const inp = document.getElementById('input'); close();
    if (!inp) return;
    inp.value = `Brief the ${slug} team (${name}): `; inp.focus();
    inp.dispatchEvent(new Event('input', {bubbles: true}));
  }
  const briefBtn = (slug, name) => `<button type="button" class="ctl run dp-brief" data-brief="${slug}" data-name="${esc(name)}">Brief ${esc(name)} ▸</button>`;

  // ── layout 1: grid of department cards ──
  const gridView = () => `<div class="dp-grid">${D.map(d => `
    <article class="dp-card" ${cv(d)}>
      <header><span class="dp-dot"></span><h3>${esc(d[1])}</h3>${dot(d[0])}<em>${d[4].length} teams</em></header>
      <p>${esc(d[2])}</p>
      <ul>${d[4].map(t => `<li><button type="button" data-brief="${t[0]}" data-name="${esc(t[1])}" title="${esc(t[2])}">
        <b>${esc(t[1])}</b><span>${esc(t[2])}</span></button></li>`).join('')}</ul>
      <footer><button type="button" class="dp-link" data-brief="${d[0]}" data-name="${esc(d[1])}">Brief whole department ▸</button></footer>
    </article>`).join('')}</div>`;

  // ── detail pane (sidebar + orbit) ──
  function detail(){
    const d = byId[sel.dept], t = sel.team && d[4].find(x => x[0] === sel.team);
    const head = t ? `<div class="dd-crumb"><button type="button" data-pick="${d[0]}">${esc(d[1])}</button> / ${esc(t[1])}</div>
        <h2>${esc(t[1])}</h2><p class="dd-remit">${esc(t[2])}</p>
        <div class="dd-meta"><span>team</span><code>${t[0]}</code><span>dept</span><code>${d[0]}</code></div>
        ${briefBtn(t[0], t[1])}`
      : `<div class="dd-crumb">Department ${dot(d[0])}</div><h2>${esc(d[1])}</h2><p class="dd-remit">${esc(d[2])}</p>
        <div class="dd-meta"><span>folder</span><code>${d[0]}</code><span>teams</span><code>${d[4].length}</code></div>
        ${briefBtn(d[0], d[1])}`;
    return `<aside class="dp-detail" ${cv(d)}>${head}
      <div class="dd-label">Sub-teams</div>
      <ul class="dd-list">${d[4].map(x => `<li><button type="button" class="${x[0] === sel.team ? 'on' : ''}" data-team="${x[0]}">
        <b>${esc(x[1])}</b><span>${esc(x[2])}</span></button></li>`).join('')}</ul></aside>`;
  }

  // ── layout 2: sidebar + detail ──
  const sidebarView = () => `<div class="dp-side"><nav class="ds-nav">${D.map(d => `
      <button type="button" class="${d[0] === sel.dept ? 'on' : ''}" data-pick="${d[0]}" ${cv(d)}>
        <span class="dp-dot"></span><span class="ds-name">${esc(d[1])}</span>${dot(d[0])}<em>${d[4].length}</em></button>`).join('')}</nav>
    <section class="ds-main">${detail()}</section></div>`;

  // ── layout 3: orbit map ──
  function orbitView(){
    const W = 1120, H = 760, cx = W / 2, cy = H / 2 + 6, R = 270, rad = a => a * Math.PI / 180;
    let ring = '', lines = '', nodes = '';
    const orbs = D.map((d, i) => {
      const a = -90 + i * 72;
      return {d, a, x: cx + R * Math.cos(rad(a)), y: cy + 240 * Math.sin(rad(a))};
    });
    for (const o of orbs){
      const {d} = o, n = d[4].length, spread = n > 5 ? 250 : n === 3 ? 90 : 100, on = d[0] === sel.dept;   // fans outward, away from the hub
      let sub = '';
      d[4].forEach((t, k) => {
        const aa = o.a + (n === 1 ? 0 : -spread / 2 + spread * k / (n - 1));
        const r = n > 5 ? 128 : 108;
        const x = o.x + r * Math.cos(rad(aa)), y = o.y + r * 0.9 * Math.sin(rad(aa));
        const act = on && t[0] === sel.team, anchor = Math.cos(rad(aa)) > .25 ? 'start' : Math.cos(rad(aa)) < -.25 ? 'end' : 'middle';
        const lx = x + (anchor === 'start' ? 12 : anchor === 'end' ? -12 : 0), ly = y + (anchor === 'middle' ? (Math.sin(rad(aa)) > 0 ? 24 : -15) : 4);
        lines += `<line x1="${o.x.toFixed(1)}" y1="${o.y.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ob-spoke" style="--c:var(${d[3]})"/>`;
        sub += `<g class="ob-sub ${act ? 'on' : ''}" data-team="${t[0]}" data-dept="${d[0]}" style="--c:var(${d[3]})" tabindex="0" role="button" aria-label="${esc(t[1])}">
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${act ? 9 : 6.5}"/>
          <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(t[1])}</text></g>`;
      });
      ring += `<line x1="${cx}" y1="${cy}" x2="${o.x.toFixed(1)}" y2="${o.y.toFixed(1)}" class="ob-arm"/>`;
      nodes += `${sub}<g class="ob-dept ${on ? 'on' : ''}" data-pick="${d[0]}" style="--c:var(${d[3]})" tabindex="0" role="button" aria-label="${esc(d[1])}">
        <circle class="halo" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="40"/><circle class="core" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="26"/>
        <text x="${o.x.toFixed(1)}" y="${(o.y + 4).toFixed(1)}" text-anchor="middle" class="ob-ini">${d[4].length}</text>
        <text x="${o.x.toFixed(1)}" y="${(o.y - 36).toFixed(1)}" text-anchor="middle" class="ob-name">${esc(d[1])}</text></g>`;
    }
    return `<div class="dp-orbit"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="Department orbit map">
      <ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="240" class="ob-ring"/><ellipse cx="${cx}" cy="${cy}" rx="${R * 1.45}" ry="${240 * 1.45}" class="ob-ring faint"/>
      ${ring}${lines}
      <g class="ob-hub"><circle cx="${cx}" cy="${cy}" r="48"/><circle cx="${cx}" cy="${cy}" r="62" class="pulse"/>
        <text x="${cx}" y="${cy + 5}" text-anchor="middle">ATLAS</text></g>${nodes}</svg>${detail()}</div>`;
  }

  function render(){
    ov.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    ov.dataset.view = view;
    body.innerHTML = view === 'sidebar' ? sidebarView() : view === 'orbit' ? orbitView() : gridView();
  }
  function setView(v){ view = v; try { localStorage.setItem(KEY, v); } catch (_) {} render(); }

  ov.addEventListener('click', e => {
    if (e.target === ov) return close();
    const t = e.target.closest('button, [data-pick], [data-team]'); if (!t) return;
    if (t.id === 'deptClose') return close();
    if (t.dataset.view) return setView(t.dataset.view);
    if (t.dataset.brief) return brief(t.dataset.brief, t.dataset.name);
    if (t.dataset.pick){ sel = {dept: t.dataset.pick, team: null}; return render(); }
    if (t.dataset.team){ sel = {dept: t.dataset.dept || sel.dept, team: t.dataset.team}; return render(); }
  });
  ov.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button]')){ e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', {bubbles: true})); }
  });
  function open(){ ov.hidden = false; render(); document.getElementById('navDepts')?.setAttribute('aria-expanded', 'true'); (ov.querySelector('[aria-pressed=true]') || ov).focus?.(); }
  function close(){ ov.hidden = true; document.getElementById('navDepts')?.setAttribute('aria-expanded', 'false'); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.hidden){ e.stopPropagation(); close(); } }, true);

  let btn = document.getElementById('navDepts');
  if (!btn){
    btn = document.createElement('button'); btn.className = 'navbtn'; btn.id = 'navDepts'; btn.textContent = 'Departments'; btn.setAttribute('aria-expanded', 'false');
    const brain = document.getElementById('navBrain'); brain ? brain.before(btn) : document.querySelector('.menu')?.appendChild(btn);
  }
  btn.addEventListener('click', () => ov.hidden ? open() : close());
  // keep status dots live while the view is open
  const rail = document.getElementById('teamRail');
  if (rail) new MutationObserver(() => { if (!ov.hidden) render(); }).observe(rail, {subtree: true, attributes: true, attributeFilter: ['class']});
  window.AtlasDepartments = {open, close, setView};
  if (/deptview=/.test(location.hash)) open();
})();
