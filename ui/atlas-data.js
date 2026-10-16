/* Atlas · shared department data + cross-view navigation.
   One source of truth for the department rail, the Departments view and the Brain graph.
   Data comes from GET /api/departments (read-only, backed by ~/Atlas/departments); the list below is the fallback
   used until/unless that answers. Colours are theme CSS variables, never hex, so every theme restyles them. */
(() => {
  'use strict';
  const T = (slug, name, remit) => ({slug, name, remit});
  const FALLBACK = [
    {slug: 'research-strategy', name: 'Research & Strategy', remit: 'Find out what is true about markets, products, competitors and opportunities, then turn it into recommendations.', teams: [
      T('market-research', 'Market Research', 'Demand, niches, audiences, trends.'),
      T('product-research', 'Product Research', 'What to make and sell: ideas, validation, pricing signals.'),
      T('competitor-intel', 'Competitor Intelligence', 'Who else is selling, what works for them, gaps to exploit.'),
      T('strategy', 'Strategy', 'Positioning, roadmap, priorities, opportunity scoring.')]},
    {slug: 'design-content', name: 'Design & Content', remit: 'Create the products and everything creative around them: designs, copy, video, images, ads and content.', teams: [
      T('product-development', 'Product Development', 'Turning researched ideas into finished, sellable products.'),
      T('pod-design', 'Print on Demand Design', 'T-shirts, mugs and other products: concepts, layouts, mockups.'),
      T('images-graphics', 'Images & Graphics', 'Brand visuals, thumbnails, product imagery.'),
      T('copywriting', 'Copywriting', 'Product pages, emails, hooks, scripts, slogans.'),
      T('video', 'Video', 'Promo, explainer and short-form video.'),
      T('short-form', 'Short-form Content', 'Posts, reels, captions, short clips.'),
      T('long-form', 'Long-form Content', 'Articles, guides, newsletters, written series.'),
      T('ads-creative', 'Ad Creative', 'Ad concepts, copy and visuals ready to run (placement belongs to Marketing).')]},
    {slug: 'marketing', name: 'Marketing', remit: 'Get the right audience to the right offer: channels, campaigns, funnels and measurement.', teams: [
      T('social-media', 'Social Media', 'Calendar, posting plan, community, platform tactics.'),
      T('paid-advertising', 'Paid Advertising', 'Campaign setup, targeting, budgets (advice only), testing.'),
      T('email-funnels', 'Email & Funnels', 'Lists, sequences, landing pages, conversion.'),
      T('analytics', 'Analytics', 'What is working, what is not, and what to do next.')]},
    {slug: 'business-operations', name: 'Business & Operations', remit: 'Keep the business running: operations, legal housekeeping, customers and the tools that automate it.', teams: [
      T('operations', 'Operations', 'Suppliers, fulfilment, workflows, checklists.'),
      T('legal-compliance', 'Legal & Compliance', 'Contracts, trademarks, policies, platform rules. Flags risk plainly.'),
      T('customer-support', 'Customer Support', 'Replies, FAQs, refunds, feedback loops.'),
      T('tech-automation', 'Tech & Automation', 'Stores, integrations, scripts, dashboards.')]},
    {slug: 'finance', name: 'Finance', remit: 'Know the numbers: budgets, pricing, revenue and costs, tax and cash flow. Advise only; never move money.', teams: [
      T('budgeting', 'Budgeting & Cash Flow', 'Budgets, forecasts, runway.'),
      T('pricing', 'Pricing & Margins', 'Unit economics, price tests, margins.'),
      T('bookkeeping-tax', 'Bookkeeping & Tax', 'Records, categories, deadlines, what to ask the accountant.')]},
  ];
  const VARS = ['--dept-1', '--dept-2', '--dept-3', '--dept-4', '--dept-5'];   // per-theme department hues (themes.css), assigned by position
  const subs = [];
  const D = {
    source: 'fallback',
    depts: FALLBACK,
    colorVar(slug){ const i = this.depts.findIndex(d => d.slug === slug); return VARS[(i < 0 ? 0 : i) % VARS.length]; },
    dept(slug){ return this.depts.find(d => d.slug === slug); },
    deptOfTeam(team){ return this.depts.find(d => d.teams.some(t => t.slug === team)); },
    onChange(fn){ subs.push(fn); },
    async load(){
      try {
        const h = typeof apiHeaders === 'function' ? apiHeaders() : {};
        const r = await fetch('/api/departments', {headers: h}).then(r => r.json());
        const list = (r.departments || []).filter(d => d && d.slug && Array.isArray(d.teams));
        if (!list.length) return;
        if (JSON.stringify(list) === JSON.stringify(this.depts)) { this.source = 'files'; return; }
        this.depts = list; this.source = 'files';
        subs.forEach(fn => { try { fn(list); } catch (_) {} });
      } catch (_) { /* keep the fallback */ }
    },
  };
  window.AtlasData = D;

  // ── navigation between the two views (each registers itself as AtlasNav.views.<name>) ──
  const views = {};
  window.AtlasNav = {
    views,
    // go('departments', {dept, team}) | go('brain', {id}) — closes the other view first
    go(name, arg){
      for (const k in views) if (k !== name) views[k].close && views[k].close();
      views[name] && views[name].open(arg);
    },
  };
  // shared header switcher so both views read as one section
  window.AtlasNav.tabs = active => `<div class="view-tabs" role="tablist" aria-label="Departments and Brain">
    ${[['departments', 'Departments'], ['brain', 'Brain']].map(([id, n]) =>
      `<button type="button" role="tab" data-nav="${id}" aria-selected="${id === active}">${n}</button>`).join('')}</div>`;
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-nav]');
    if (b) window.AtlasNav.go(b.dataset.nav);
  });
  setTimeout(() => D.load(), 0);          // after app.js has defined apiHeaders
  // deep link: #open=brain&focus=pricing  /  #open=departments&dept=finance  (combine with #theme=…&mode=…)
  setTimeout(() => {
    const h = location.hash, m = /open=(brain|departments)/.exec(h); if (!m) return;
    const f = /focus=([a-z0-9-]+)/.exec(h), d = /dept=([a-z0-9-]+)/.exec(h);
    window.AtlasNav.go(m[1], m[1] === 'brain' ? (f && f[1]) : (d && {dept: d[1], team: f && f[1]}) || undefined);
  }, 50);
})();
