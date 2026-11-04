// ══════════ chat composer attachments (additive; inbox, Brain and voice untouched) ══════════
// Files land in <project>/attachments/<YYYY-MM-DD>/ via POST /api/attach and their
// ABSOLUTE paths are appended to the outgoing message, so the agent knows what to open.
// Nothing here routes through the inbox or touches ~/Atlas.
(() => {
  'use strict';
  const input  = document.getElementById('input');
  const btn    = document.getElementById('attachBtn');
  const picker = document.getElementById('attachInput');
  const chips  = document.getElementById('attachChips');
  const card   = document.getElementById('responseWrap');
  const composer = document.querySelector('.composer');
  if (!input || !btn || !picker || !chips) return;

  const note = (kind, label, msg) => { try { log(kind, label, msg); } catch (_) {} };
  const fmtSize = n => n < 1024 ? n + ' B'
    : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
    : (n / 1048576).toFixed(1) + ' MB';
  const HEADER = 'Attached files (read these):';
  // The server caps the upload body at 32 MB and base64 adds a third, so ~23 MB is the
  // real limit. Say so before reading and uploading the whole file only to be refused.
  const MAX_BYTES = 23 * 1024 * 1024;

  let pending = [];          // {name, bytes, path, mime, error, uploading, el}

  function renderChips(){
    chips.innerHTML = '';
    chips.hidden = pending.length === 0;
    for (const a of pending){
      const el = document.createElement('span');
      el.className = 'attachchip' + (a.error ? ' err' : '') + (a.uploading ? ' busy' : '');
      if (a.error){
        el.innerHTML = '<span class="aico">⚠</span>'
          + `<span class="aname">${esc(a.name)}</span>`
          + `<span class="asize">${esc(a.error)}</span>`;
      } else if (a.uploading){
        el.innerHTML = '<span class="aico">📎</span>'
          + `<span class="aname">${esc(a.name)}</span><span class="asize">saving…</span>`;
      } else {
        el.innerHTML = '<span class="aico">📎</span>'
          + `<span class="aname" title="${esc(a.path || a.name)}">${esc(a.name)}</span>`
          + `<span class="asize">${fmtSize(a.bytes)}</span>`;
      }
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'ax'; x.textContent = '✕';
      x.setAttribute('aria-label', 'Remove ' + a.name);
      x.addEventListener('click', ev => { ev.preventDefault(); remove(a); });
      el.appendChild(x);
      a.el = el;
      chips.appendChild(el);
    }
    btn.classList.toggle('on', pending.some(a => a.path && !a.error));
  }

  function remove(a){
    const i = pending.indexOf(a);
    if (i >= 0) pending.splice(i, 1);
    renderChips();
    input.focus();
  }

  function readDataURL(file){
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => rej(new Error('could not read the file'));
      fr.readAsDataURL(file);
    });
  }

  async function attachFile(file){
    if (!file) return null;
    const name = file.name || 'file';
    if (!file.size){                                     // never silently drop it
      const bad = {name, bytes: 0, error: 'empty file'};
      pending.push(bad); renderChips();
      note('error', 'ATTACH', `${name}: the file is empty — nothing was saved`);
      return bad;
    }
    if (file.size > MAX_BYTES){
      const bad = {name, bytes: file.size, error: 'too large (max 23 MB)'};
      pending.push(bad); renderChips();
      note('error', 'ATTACH', `${name}: ${fmtSize(file.size)} is over the 23 MB limit — nothing was saved`);
      return bad;
    }
    const entry = {name, bytes: file.size, uploading: true};
    pending.push(entry); renderChips();
    let data;
    try { data = await readDataURL(file); }
    catch (e){
      entry.uploading = false; entry.error = 'read failed'; renderChips();
      note('error', 'ATTACH', `${name}: ${e.message || 'could not read the file'}`);
      return entry;
    }
    try {
      const r = await fetch('/api/attach', {
        method: 'POST',
        headers: apiHeaders({'content-type': 'application/json'}),
        body: JSON.stringify({name, data_base64: data, kind: file.type || ''}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !j.path) throw new Error(j.error || ('HTTP ' + r.status));
      entry.uploading = false;
      entry.path = j.path; entry.name = j.name || entry.name;
      entry.bytes = (j.bytes != null) ? j.bytes : entry.bytes;
      entry.mime = j.mime_guess;
      note('note', 'ATTACH', `${entry.name} (${fmtSize(entry.bytes)}) → ${entry.path}`);
    } catch (e){
      entry.uploading = false;
      const why = String(e.message || e).replace(/\s+/g, ' ').trim().slice(0, 60);
      entry.error = (why && why !== 'undefined') ? why : 'upload failed';
      renderChips();
      note('error', 'ATTACH', `${name}: ${String(e.message || e).slice(0, 180)} — file was NOT attached`);
      return entry;
    }
    renderChips();
    return entry;
  }

  async function attachFiles(fileList){
    const files = Array.from(fileList || []);
    if (!files.length) return;
    input.focus();
    for (const f of files) await attachFile(f);
  }

  const readyPaths = () => pending.filter(a => a.path && !a.error).map(a => a.path);

  // Append the saved absolute paths to the outgoing text just before the existing
  // send handlers read #input — so Enter, ⌘↵ and the Send button all carry them,
  // and something with attachments but no typed text still sends.
  function prepareSend(){
    const paths = readyPaths();
    if (!paths.length) return false;
    const typed = input.value.replace(/\s+$/, '');
    input.value = (typed ? typed + '\n\n' : '') + HEADER + '\n' + paths.join('\n');
    pending = pending.filter(a => !(a.path && !a.error));   // failed entries stay visible
    renderChips();
    note('send', 'ATTACH', `sending ${paths.length} attachment${paths.length > 1 ? 's' : ''} with this message`);
    return true;
  }

  // capture phase: runs before the existing Enter / ⌘↵ / Send handlers
  document.addEventListener('keydown', e => {
    if (e.target !== input || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const sm = document.getElementById('slashMenu');
    if (sm && !sm.hidden) return;                        // picking a slash command, not sending
    prepareSend();
  }, true);
  document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('#run')) prepareSend();
  }, true);

  btn.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    if (picker.files && picker.files.length) attachFiles(picker.files);
    picker.value = '';
  });

  // paste a file/image straight into the composer
  input.addEventListener('paste', e => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;                           // plain text paste behaves as before
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (text) { try { document.execCommand('insertText', false, text); } catch (_) {} }
    attachFiles(files);
  });

  // drag & drop onto the chat card or the composer (queued behind the inbox overlay's
  // window handler, which is stopped here so a chat drop never becomes an inbox item)
  const isFileDrag = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  [card, composer].filter(Boolean).forEach(zone => {
    zone.addEventListener('dragenter', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragover', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', e => {
      e.stopPropagation(); zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('dragover');
      const overlay = document.getElementById('windowDropOverlay');
      if (overlay) overlay.hidden = true;                // this drop is for the chat
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)
        attachFiles(e.dataTransfer.files);
    });
  });

  renderChips();

  // small read-only surface so tests (and other panels) can inspect/queue attachments
  window.AtlasAttach = {
    open: () => picker.click(),
    attach: attachFile,
    attachFiles,
    prepareSend,
    pending: () => pending.map(a => ({name: a.name, path: a.path || null, error: a.error || null})),
    paths: readyPaths,
    list: () => fetch('/api/attachments', {headers: apiHeaders()}).then(r => r.json()),
  };
})();
