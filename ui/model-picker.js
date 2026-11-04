// ══════════ settings: provider + model picker (front-end over /api/models) ══════════
// The backend already discovers the real provider/model catalog (GET /api/models) and
// persists the choice (POST /api/settings); this only drives the panel. The active line
// by the orb is read LIVE from GET /api/settings, so a change made on the Hermes side
// shows up on reload instead of a stale stored value — a stored choice is an override
// only when it differs (the backend already enforces that).
(() => {
  const provSel  = $('#set-provider');
  const modelIn  = $('#set-model');
  const modelList= $('#modelList');
  const clearBtn = $('#modelClear');
  const noteEl   = $('#modelNote');
  const testBtn  = $('#modelTest');
  const testOut  = $('#modelTestOut');
  const openBtn  = $('#settingsBtn');
  const saveBtn  = $('#settingsSave');
  const activeEl = $('#stModel');
  if (!provSel || !modelIn || !modelList) return;

  const DEFAULT_LABEL = 'Hermes default';
  const apiJson = extra => fetch(extra.url, {headers: apiHeaders(extra.headers), method: extra.method || 'GET',
                                             body: extra.body}).then(r => r.json());

  let metaById = {};                    // provider id (and its aliases) -> catalog entry
  const modelsByProvider = {};          // provider id -> {models:[], reason:''}
  let listOpen = false, selIdx = -1, shownOpts = [];
  let liveProviderId = '', liveModel = '';

  const optText = p => {
    let t = p.label || p.id;
    if (p.local){ if (p.reachable === false) t += ' · server down'; }
    else if (!p.authenticated) t += ' · not signed in';
    return t;
  };
  const providerMeta   = () => metaById[provSel.value] || null;
  const isNoCreds      = () => { const m = providerMeta(); return !!(m && !m.local && !m.authenticated); };
  const isLocalDown    = () => { const m = providerMeta(); return !!(m && m.local && m.reachable === false); };
  const blockedReason  = () => isNoCreds() ? 'no credentials' : (isLocalDown() ? 'server down' : '');
  const syncClear      = () => { clearBtn.hidden = !modelIn.value.trim(); };
  const setNote        = msg => { noteEl.hidden = !msg; noteEl.textContent = msg || ''; };

  // ── the active provider·model line by the orb — always the LIVE value from Hermes ──
  async function renderActive(){
    if (!activeEl) return;
    try {
      const s = await apiJson({url: '/api/settings'});
      const prov = s.model_provider || DEFAULT_LABEL;
      const mod  = s.model_name || DEFAULT_LABEL;
      const override = !!s.model_override;
      activeEl.innerHTML = `<span class="smo">${esc(prov)}</span>`
        + (mod && mod !== DEFAULT_LABEL ? ' · ' + esc(mod) : '')
        + (override ? '<span class="smo-badge">OVERRIDE</span>' : '');
      activeEl.title = override
        ? `Override in effect — Hermes is configured for ${s.model_provider_native} · ${s.model_name_native}`
        : 'Active provider and model, read live from Hermes';
    } catch (_) { /* keep the last known value rather than blanking it */ }
  }

  // ── Provider select, from a models_catalog() providers list ──
  function fillProviders(providers, selectedId){
    metaById = {};
    const ids = new Set();
    const opts = [`<option value="">${esc(DEFAULT_LABEL)}</option>`];
    for (const p of (providers || [])){
      if (!p || !p.id || ids.has(p.id)) continue;
      ids.add(p.id);
      metaById[p.id] = p;
      for (const a of (p.aliases || [])) metaById[a] = p;
      const unusable = !p.local && !p.authenticated;
      const isSel = p.id === selectedId;
      opts.push(`<option value="${esc(p.id)}"${unusable && !isSel ? ' disabled' : ''}>${esc(optText(p))}</option>`);
    }
    // never silently drop a live provider the catalog did not enumerate
    if (selectedId && selectedId !== DEFAULT_LABEL && !ids.has(selectedId)){
      opts.push(`<option value="${esc(selectedId)}">${esc(selectedId)}</option>`);
    }
    provSel.innerHTML = opts.join('');
    provSel.value = (selectedId && selectedId !== DEFAULT_LABEL) ? selectedId : '';
    if (provSel.selectedIndex < 0) provSel.value = '';
  }

  // keep the provider labels honest when a fresh catalog changes auth / reachability
  function relabelProviders(){
    for (const o of provSel.options){
      const p = o.value && metaById[o.value];
      if (p) o.textContent = optText(p);
    }
  }

  // ── searchable Model combobox (list is scoped to the chosen provider) ──
  // No argument = show the whole list (focus/click/provider change); pass the typed
  // text to filter as the user types.
  function renderModels(filter){
    const raw = (filter === undefined) ? '' : String(filter);
    const q = raw.trim().toLowerCase();
    const pid = provSel.value;
    const entry = modelsByProvider[pid] || {models: [], reason: ''};
    const all = entry.models || [];
    const shown = all.filter(m => !q || m.toLowerCase().includes(q));
    const blocked = blockedReason();
    shownOpts = [];
    if (!shown.length){
      const why = (all.length && q)
        ? `No model matches “${raw.trim()}”.`
        : (entry.reason || (pid ? 'No models discovered for this provider.'
                                : `No override — ${DEFAULT_LABEL} is in use.`));
      modelList.innerHTML = `<div class="combo-empty">${esc(why)}</div>`;
      return;
    }
    modelList.innerHTML = shown.map((m, i) => {
      const cur = !blocked && m === modelIn.value.trim();
      const tag = blocked ? `<span class="co-tag">${esc(blocked)}</span>` : '';
      shownOpts.push(m);
      return `<div class="combo-opt${blocked ? ' disabled' : ''}${cur ? ' sel' : ''}" role="option"`
        + ` data-i="${i}" aria-disabled="${blocked ? 'true' : 'false'}">${esc(m)}${tag}</div>`;
    }).join('');
  }
  function openList(){ listOpen = true; modelList.hidden = false; modelIn.setAttribute('aria-expanded', 'true');
                       selIdx = -1; renderModels(); }
  function closeList(){ listOpen = false; modelList.hidden = true; modelIn.setAttribute('aria-expanded', 'false'); selIdx = -1; }
  function pick(i){
    const m = shownOpts[i];
    if (m == null) return;
    if (blockedReason()){ setNote(`That provider is unavailable (${blockedReason()}), so its models can’t be chosen.`); return; }
    modelIn.value = m; syncClear(); closeList(); setNote('');
  }

  // ── fetch the models for a provider (discovery is provider-scoped server-side) ──
  async function loadModelsFor(pid, force){
    if (force || !(pid in modelsByProvider)){
      try {
        const url = '/api/models' + (pid ? '?provider=' + encodeURIComponent(pid) : '');
        const cat = await apiJson({url});
        modelsByProvider[pid] = {models: cat.models || [], reason: cat.reason || ''};
        for (const p of (cat.providers || [])){       // refresh auth / reachability too
          if (!p || !p.id) continue;
          metaById[p.id] = p;
          for (const a of (p.aliases || [])) metaById[a] = p;
        }
        relabelProviders();
      } catch (e){
        modelsByProvider[pid] = {models: [], reason: 'Could not load models: ' + (e.message || e)};
      }
    }
    renderModels();
    const entry = modelsByProvider[pid] || {};
    const m = metaById[pid];
    let msg = '';
    if (m && m.local && m.reachable === false)        msg = entry.reason || 'The local llama.cpp server is not running.';
    else if (m && !m.local && !m.authenticated)       msg = entry.reason || `No credentials available for ${m.label || pid}. Sign in with \`hermes model\`.`;
    else if (!(entry.models || []).length)            msg = entry.reason || '';
    setNote(msg);
  }

  // ── open: load the live choice + the catalog, then populate both controls ──
  async function openPicker(){
    try {
      const s = await apiJson({url: '/api/settings'});
      liveProviderId = s.model_provider || '';
      liveModel = s.model_name || '';
      const cat = await apiJson({url: '/api/models'});
      const targetId = (cat.provider && cat.provider.id) || liveProviderId;
      modelsByProvider[targetId] = {models: cat.models || [], reason: cat.reason || ''};
      if (liveProviderId && liveProviderId !== targetId) modelsByProvider[liveProviderId] = modelsByProvider[targetId];
      fillProviders(cat.providers, targetId);
      modelIn.value = (liveModel && liveModel !== DEFAULT_LABEL) ? liveModel : '';
      syncClear();
      renderModels();
      const m = metaById[provSel.value];
      let msg = '';
      if (m && m.local && m.reachable === false)      msg = modelsByProvider[provSel.value]?.reason || 'The local llama.cpp server is not running.';
      else if (m && !m.local && !m.authenticated)     msg = modelsByProvider[provSel.value]?.reason || `No credentials available for ${m.label || provSel.value}.`;
      else if (!(modelsByProvider[provSel.value]?.models || []).length) msg = modelsByProvider[provSel.value]?.reason || '';
      setNote(msg);
      const t = modelsByProvider[provSel.value]?.models || [];
      log('note', 'MODELS', `${(cat.providers || []).length} providers · ${t.length} model${t.length === 1 ? '' : 's'} for ${provSel.value || DEFAULT_LABEL}`);
    } catch (e){
      log('error', 'MODELS', 'could not load the model catalog: ' + (e.message || e));
    }
  }

  // ── wiring ──
  provSel.addEventListener('change', async () => {
    const pid = provSel.value;
    modelIn.value = (pid === liveProviderId) ? ((liveModel && liveModel !== DEFAULT_LABEL) ? liveModel : '') : '';
    syncClear(); closeList();
    log('note', 'MODELS', `provider → ${pid || DEFAULT_LABEL}; loading models…`);
    await loadModelsFor(pid, true);
    log('note', 'MODELS', `${(modelsByProvider[pid]?.models || []).length} model(s) for ${pid || DEFAULT_LABEL}`);
  });

  modelIn.addEventListener('focus', openList);
  modelIn.addEventListener('click', () => { if (!listOpen) openList(); });
  modelIn.addEventListener('input', () => { syncClear(); if (!listOpen) openList(); else renderModels(modelIn.value); });
  modelIn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if (!listOpen) return openList();
      const n = shownOpts.length; if (!n) return;
      if (selIdx < 0) selIdx = (e.key === 'ArrowDown') ? 0 : n - 1;
      else selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      modelList.querySelectorAll('.combo-opt').forEach((o, i) => o.classList.toggle('sel', i === selIdx));
      const el = modelList.querySelector('.combo-opt.sel'); if (el) el.scrollIntoView({block: 'nearest'});
    } else if (e.key === 'Enter'){
      if (listOpen && selIdx >= 0){ e.preventDefault(); pick(selIdx); } else closeList();
    } else if (e.key === 'Escape' && listOpen){
      e.preventDefault(); e.stopPropagation(); closeList();      // don't also hush the orb
    }
  });
  modelList.addEventListener('mousedown', e => {
    const opt = e.target.closest('.combo-opt'); if (!opt) return;
    e.preventDefault();                    // keep focus on the input
    pick(parseInt(opt.dataset.i, 10));
  });
  document.addEventListener('mousedown', e => { if (listOpen && !e.target.closest('#modelCombo')) closeList(); });
  clearBtn.addEventListener('click', () => { modelIn.value = ''; syncClear(); openList(); });

  // ── Test connection → POST /api/models/test, result or error inline ──
  testBtn.addEventListener('click', async () => {
    const pid = provSel.value, model = modelIn.value.trim();
    testBtn.disabled = true;
    testOut.className = 'testout'; testOut.textContent = 'testing…';
    try {
      const r = await apiJson({url: '/api/models/test', method: 'POST', headers: {'content-type': 'application/json'},
                               body: JSON.stringify({provider: pid, model})});
      if (r && r.ok){
        testOut.className = 'testout ok';
        testOut.textContent = `✓ round-trip: ${r.reply || 'ok'}${r.ms != null ? ' · ' + r.ms + ' ms' : ''}`;
      } else {
        testOut.className = 'testout err';
        testOut.textContent = '✕ ' + ((r && r.error) || 'the test failed');
      }
    } catch (e){
      testOut.className = 'testout err';
      testOut.textContent = '✕ ' + (e.message || 'could not reach the test endpoint');
    } finally { testBtn.disabled = false; }
  });

  // ── save provider + model through the existing settings save path ──
  saveBtn.addEventListener('click', async () => {
    const body = {model_provider: provSel.value, model_name: modelIn.value.trim()};
    try {
      const r = await apiJson({url: '/api/settings', method: 'POST', headers: {'content-type': 'application/json'},
                               body: JSON.stringify(body)});
      if (r && r.error){ log('error', 'SETTINGS', r.error); return; }
      await renderActive();      // reflect the LIVE effective value, not the stored one
      log('note', 'SETTINGS', `model → ${r.model_provider || DEFAULT_LABEL} · ${r.model_name || DEFAULT_LABEL}${r.model_override ? ' (override)' : ''}`);
    } catch (_){ log('error', 'SETTINGS', 'could not save provider/model'); }
  });

  if (openBtn) openBtn.addEventListener('click', () => { openPicker(); renderActive(); });

  renderActive();
  setInterval(renderActive, 30000);      // keep the orb line live as Hermes-side config changes

  // small read-only surface for tests / other panels
  window.AtlasModels = {
    open: openPicker,
    active: renderActive,
    catalog: () => ({provider: provSel.value, providers: Object.values(metaById)
      .filter((p, i, a) => a.findIndex(q => q.id === p.id) === i).map(p => p.id),
      models: shownOpts.slice()}),
    modelsFor: pid => (modelsByProvider[pid]?.models || []).slice(),
    note: () => noteEl.textContent,
    blocked: () => blockedReason(),
  };
})();
