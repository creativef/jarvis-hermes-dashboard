/* ═══════════ Atlas · local markdown reader ═══════════
   A tiny, dependency-free markdown renderer used by the Brain note panel, the
   Departments note views and the Inbox previews. No network, no CDN, no eval:
   it turns a markdown string into a safe HTML string (every piece of text is
   escaped first, so a note can never inject markup).

   Supports: headings, bold, italics, inline code, fenced code blocks, links,
   bullet and numbered lists (nested), blockquotes, horizontal rules, pipe
   tables, [[wikilinks]] (kept clickable, id preserved for the Brain graph),
   and callout styling for inbox "Proposed triage"-style metadata lines.

   Exposes: window.AtlasMarkdown = { render, renderInline, escapeHtml }.
   render(md, opts) -> html string.  opts.wikilinks === false disables links. */
(() => {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

  // only these schemes/forms may become a real href; anything else stays text
  const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/|#|\.{1,2}\/)/i;

  // a bold label followed by a colon, e.g. "- **Proposed triage:** …"
  const META_RE = /^\*\*(.+?):\*\*\s*([\s\S]*)$/;
  const metaOf = text => {
    const m = META_RE.exec(String(text).trim());
    return m ? { label: m[1].trim(), body: m[2] } : null;
  };

  // ── inline: escape, then markdown, then restore protected spans ──────────
  function renderInline(text, opts) {
    opts = opts || {};
    let s = escapeHtml(text);

    // protect inline code spans first so ** and _ inside them are literal
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001'; });

    // links [label](url) — unsafe schemes are dropped back to plain label text
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = url.trim();
      if (!SAFE_URL.test(href)) return m;               // unsafe scheme: keep as plain text
      return `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // wikilinks [[id]] / [[id|label]] / [[id#section]] — id is preserved verbatim
    if (opts.wikilinks !== false) {
      s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, raw, label) => {
        const id = raw.trim();
        const txt = (label != null ? label : id).trim();
        return `<a class="md-wikilink" href="#" role="link" data-node="${id}" title="Open ${id}">${txt}</a>`;
      });
    }

    // emphasis (code spans are already parked on \u0001 placeholders)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');

    s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => `<code>${codes[+i]}</code>`);
    return s;
  }

  // inline + keep author line breaks (single newline -> <br>)
  const soft = (t, opts) => renderInline(t, opts).replace(/\n/g, '<br>');

  // ── block helpers ────────────────────────────────────────────────────────
  const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const QUOTE_RE = /^\s{0,3}>\s?/;
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const FENCE_RE = /^(\s*)(```|~~~)\s*([\w+#.-]*)\s*$/;

  const isDelim = line => {
    const t = line.trim();
    if (!t.includes('|')) return false;
    return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
  };

  function startsBlock(line, next) {
    if (FENCE_RE.test(line)) return true;
    if (HEAD_RE.test(line)) return true;
    if (HR_RE.test(line)) return true;
    if (QUOTE_RE.test(line)) return true;
    if (LIST_RE.test(line)) return true;
    if (line.includes('|') && next != null && isDelim(next)) return true;
    return false;
  }

  function splitRow(row) {
    let r = row.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|')) r = r.slice(0, -1);
    return r.split('|').map(c => c.trim());
  }

  const alignOf = cell => {
    const c = cell.trim();
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  };

  // render a flat list of {indent, ordered, text} into nested <ul>/<ol>
  function nest(items) {
    const top = { indent: -1, children: [] };
    const stack = [top];
    for (const it of items) {
      while (stack.length && it.indent <= stack[stack.length - 1].indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : top;
      const node = { indent: it.indent, ordered: it.ordered, text: it.text, children: [] };
      parent.children.push(node);
      stack.push(node);
    }
    return top;
  }

  function listItemHtml(text) {
    const meta = metaOf(text);
    if (meta) {
      const triage = /proposed\s+triage/i.test(meta.label);
      const cls = 'md-meta' + (triage ? ' md-callout md-callout-triage' : '');
      return `<li class="${cls}"><span class="md-meta-label">${renderInline(meta.label)}</span><span class="md-meta-body">${soft(meta.body)}</span></li>`;
    }
    return `<li>${soft(text)}</li>`;
  }

  function renderNodes(parent) {
    let html = '';
    let i = 0;
    while (i < parent.children.length) {
      const ordered = parent.children[i].ordered;
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag} class="md-list">`;
      while (i < parent.children.length && parent.children[i].ordered === ordered) {
        const c = parent.children[i];
        const inner = listItemHtml(c.text);
        html += c.children.length
          ? inner.replace(/<\/li>$/, renderNodes(c) + '</li>')
          : inner;
        i++;
      }
      html += `</${tag}>`;
    }
    return html;
  }

  function renderTable(header, aligns, rows) {
    const th = header.map((c, k) => {
      const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
      return `<th${a}>${renderInline(c)}</th>`;
    }).join('');
    const body = rows.map(r => '<tr>' + header.map((_, k) => {
      const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
      return `<td${a}>${renderInline(r[k] != null ? r[k] : '')}</td>`;
    }).join('') + '</tr>').join('');
    return `<div class="md-tablewrap"><table class="md-table"><thead><tr>${th}</tr></thead>` +
           (body ? `<tbody>${body}</tbody>` : '') + '</table></div>';
  }

  // ── main ─────────────────────────────────────────────────────────────────
  function render(md, opts) {
    opts = opts || {};
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    const n = lines.length;
    const out = [];
    let i = 0;

    while (i < n) {
      const line = lines[i];

      // fenced code block
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const close = new RegExp('^\\s*' + fence[2]);
        const buf = [];
        i++;
        while (i < n && !close.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < n) i++;                                   // consume closing fence
        const lang = fence[3] ? ` data-lang="${escapeHtml(fence[3])}"` : '';
        const cls = fence[3] ? `md-code lang-${escapeHtml(fence[3])}` : 'md-code';
        out.push(`<pre class="md-pre"><code class="${cls}"${lang}>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      if (/^\s*$/.test(line)) { i++; continue; }

      // horizontal rule
      if (HR_RE.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }

      // heading
      const h = HEAD_RE.exec(line);
      if (h) {
        const lv = h[1].length;
        out.push(`<h${lv} class="md-h md-h${lv}">${renderInline(h[2], opts)}</h${lv}>`);
        i++;
        continue;
      }

      // blockquote
      if (QUOTE_RE.test(line)) {
        const buf = [];
        while (i < n && QUOTE_RE.test(lines[i])) { buf.push(lines[i].replace(QUOTE_RE, '')); i++; }
        out.push(`<blockquote class="md-quote">${soft(buf.join('\n'), opts)}</blockquote>`);
        continue;
      }

      // pipe table
      if (line.includes('|') && i + 1 < n && isDelim(lines[i + 1])) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(alignOf);
        i += 2;
        const rows = [];
        while (i < n && lines[i].includes('|') && !/^\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push(renderTable(header, aligns, rows));
        continue;
      }

      // list block
      if (LIST_RE.test(line)) {
        const items = [];
        while (i < n) {
          const m = LIST_RE.exec(lines[i]);
          if (!m) break;
          items.push({
            indent: m[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(m[2]),
            text: m[3],
          });
          i++;
        }
        out.push(renderNodes(nest(items)));
        continue;
      }

      // paragraph (consecutive non-blank lines that do not start a new block)
      const buf = [line];
      i++;
      while (i < n && !/^\s*$/.test(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
        buf.push(lines[i]);
        i++;
      }
      const only = buf.length === 1 ? metaOf(buf[0]) : null;
      if (only) {
        const triage = /proposed\s+triage/i.test(only.label);
        out.push(`<div class="md-meta${triage ? ' md-callout md-callout-triage' : ''}">` +
                 `<span class="md-meta-label">${renderInline(only.label)}</span>` +
                 `<span class="md-meta-body">${soft(only.body, opts)}</span></div>`);
      } else {
        out.push(`<p class="md-p">${soft(buf.join('\n'), opts)}</p>`);
      }
    }

    return out.join('\n');
  }

  window.AtlasMarkdown = { render, renderInline, escapeHtml };
})();
