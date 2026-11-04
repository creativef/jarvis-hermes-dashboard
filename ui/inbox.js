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
