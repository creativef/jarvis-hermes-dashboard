"""
Read-only view of the Atlas second brain (a folder of linked markdown notes),
plus the local Inbox store under <brain>/inbox/ so dropped files, CSVs, and
quick notes link directly into the Brain graph.

Builds a graph from [[wikilinks]] so the dashboard can draw it, and serves a
single note's text on request. Note lookups go by note name only (never a
caller-supplied path), and inbox filenames/IDs are strictly sanitised so the
API cannot be used to read or write files outside the brain folder.
"""
import base64
import datetime
import json
import os
import pathlib
import re
import time
import uuid

ROOT = pathlib.Path(os.environ.get("ATLAS_BRAIN", "~/Atlas")).expanduser()
_LINK = re.compile(r"\[\[([^\]|#]+)")
_MAX_NOTE = 200_000
_MAX_INBOX_BYTES = 10 * 1024 * 1024
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

_ALLOWED_EXTS = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".pdf",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".mp3", ".wav", ".m4a", ".ogg", ".webm", ".html", ".xml",
}
_BLOCKED_EXTS = {
    ".sh", ".bash", ".zsh", ".command", ".app", ".exe", ".dll", ".so",
    ".dylib", ".bat", ".cmd", ".ps1", ".py", ".rb", ".pl", ".php", ".js", ".mjs",
}


def _notes():
    """{name: Path} for every markdown note in the brain (first one wins)."""
    out = {}
    if not ROOT.is_dir():
        return out
    for p in sorted(ROOT.rglob("*.md")):
        rel = p.relative_to(ROOT).parts
        if any(part.startswith(".") for part in rel):
            continue
        if rel[0] == "inbox" and p.stem.endswith("-source"):   # original of a .md drop; its companion note is the node
            continue
        out.setdefault(p.stem, p)
    return out


def _classify(name, path):
    rel = path.relative_to(ROOT).parts
    if name == "Atlas":
        return "hub", ""
    if rel[0] == "departments" and len(rel) >= 3:
        dept = rel[1]
        if name.endswith("-notebook"):
            return "notebook", dept
        if len(rel) == 3:
            return "dept", dept
        return "sub", dept
    if rel[0] == "inbox":
        return "inbox", ""
    if rel[0] == "commons":
        return "commons", ""
    if rel[0] == "log":
        return "log", ""
    return "other", ""


_ORDER = ["research-strategy", "design-content", "marketing", "business-operations", "finance"]
_SUB = re.compile(r"^-\s*\[\[([^\]|#]+)\]\]\s+-\s+(.+?)\s+-\s+(.+?)\s*$")


def _section(text, title):
    m = re.search(r"^##\s+" + re.escape(title) + r"\s*\n(.*?)(?=^##\s|\Z)", text, re.S | re.M)
    return m.group(1).strip() if m else ""


def _pretty(s):
    return s.strip().replace(" and ", " & ")


def departments():
    """Departments (with their sub-teams) read from <brain>/departments/<slug>/<slug>.md.

    Read-only; slugs come from directory names, never from the caller."""
    base = ROOT / "departments"
    out = []
    if not base.is_dir():
        return {"departments": out, "root": str(base), "exists": False}
    slugs = sorted((p.name for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")),
                   key=lambda s: (_ORDER.index(s) if s in _ORDER else len(_ORDER), s))
    for slug in slugs:
        f = base / slug / (slug + ".md")
        try:
            text = f.read_text(encoding="utf-8")[:_MAX_NOTE]
        except OSError:
            continue
        head = re.search(r"^#\s+(.+?)\s*$", text, re.M)
        name = _pretty(re.sub(r"\s+department$", "", head.group(1), flags=re.I)) if head else slug
        teams = []
        for line in _section(text, "Sub-teams").splitlines():
            m = _SUB.match(line.strip())
            if m and (base / slug / m.group(1)).is_dir():
                teams.append({"slug": m.group(1), "name": _pretty(m.group(2)), "remit": m.group(3)})
        out.append({"slug": slug, "name": name, "remit": _section(text, "Remit"), "teams": teams})
    return {"departments": out, "root": str(base), "exists": True}


def _remember_births(stamps):
    """Keep each note's first-seen creation time in <brain>/.atlas/born.json. Editors and
    agents that save by replacing the file reset the OS creation time; the timeline must not
    treat every edited note as new."""
    path = ROOT / ".atlas" / "born.json"
    try:
        known = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(known, dict):
            known = {}
    except (OSError, ValueError):
        known = {}
    changed = False
    for name, (born, mtime) in stamps.items():
        old = known.get(name)
        if isinstance(old, (int, float)) and old < born:
            stamps[name] = (old, mtime)
        elif old != born:
            known[name] = born
            changed = True
    if changed and ROOT.is_dir():
        try:
            path.parent.mkdir(exist_ok=True)
            _atomic_write(path, json.dumps(known))
        except OSError:
            pass


def graph():
    notes = _notes()
    nodes, edges, seen, kinds = [], [], set(), {}
    stamps = {}
    for name, path in notes.items():
        kinds[name] = _classify(name, path)
        try:
            text = path.read_text(encoding="utf-8")[:_MAX_NOTE]
            st = path.stat()
        except OSError:
            continue
        # born: creation time where the OS keeps one (macOS), else last change
        stamps[name] = (getattr(st, "st_birthtime", st.st_mtime), st.st_mtime)
        for tgt in set(m.strip() for m in _LINK.findall(text)):
            if tgt in notes and tgt != name:
                key = tuple(sorted((name, tgt)))
                if key not in seen:
                    seen.add(key)
                    edges.append({"source": name, "target": tgt})
    _remember_births(stamps)
    linked = {e["source"] for e in edges} | {e["target"] for e in edges}
    for name, (kind, group) in kinds.items():
        if kind == "other" and name not in linked:   # unlinked strays would only float
            continue
        born, mtime = stamps.get(name, (0, 0))
        nodes.append({"id": name, "type": kind, "group": group, "born": born, "mtime": mtime})
    return {"nodes": nodes, "links": edges, "root": str(ROOT), "exists": ROOT.is_dir()}


def note(name):
    path = _notes().get(name)
    if path is None:
        return None
    try:
        text = path.read_text(encoding="utf-8")[:_MAX_NOTE]
        st = path.stat()
    except OSError:
        return None
    return {"id": name, "path": str(path.relative_to(ROOT)), "text": text,
            "mtime": st.st_mtime, "editable": st.st_size <= _MAX_NOTE}


# ── editing: create / save / link / suggest (note NAMES only, never caller paths) ──
_TITLE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$")


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def _phrase(name):
    """Regex matching a note name as words in prose: 'pod-idea-queue' ~ 'POD idea queue'."""
    words = _norm(name).split()
    return re.compile(r"(?<![A-Za-z0-9])" + r"[\s_-]+".join(map(re.escape, words)) + r"(?![A-Za-z0-9])", re.I) if words else None


def _links_in(text):
    return {m.strip() for m in _LINK.findall(text)}


def _atomic_write(path, text):
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def find_note(query, min_tier=1):
    """Best note for a spoken phrase ("my pricing notes" -> "pricing"), or None.
    Exact name beats prefix beats phrase-inside-name beats all-words-present; shorter names win ties."""
    q = re.sub(r"^(?:my|the|our)\s+", "", _norm(query))
    q = re.sub(r"\s+(?:notes?|note book|page|file|doc)$", "", q).strip()
    if not q:
        return None
    words, best = set(q.split()), None
    for name in _notes():
        n = _norm(name)
        if n == q:
            tier = 4
        elif n.startswith(q + " ") or n.endswith(" " + q):
            tier = 3
        elif f" {q} " in f" {n} ":
            tier = 2
        elif words <= set(n.split()):
            tier = 1
        else:
            continue
        if tier < min_tier:
            continue
        key = (tier, -len(n))
        if best is None or key > best[0]:
            best = (key, name)
    return best[1] if best else None


def save_note(name, text, base_mtime=None):
    """Overwrite an existing note. Refuses notes too big to have been loaded whole, and
    edits made against an older copy (someone - e.g. Atlas itself - changed it meanwhile)."""
    path = _notes().get(name)
    if path is None:
        return None, "note not found"
    if not isinstance(text, str) or len(text) > _MAX_NOTE:
        return None, "note text missing or too large"
    st = path.stat()
    if st.st_size > _MAX_NOTE:
        return None, "this note is too large to edit here"
    if base_mtime is not None:
        try:
            if abs(st.st_mtime - float(base_mtime)) > 0.001:
                return None, "conflict: this note changed on disk since you opened it"
        except (TypeError, ValueError):
            return None, "bad base_mtime"
    _atomic_write(path, text)
    return note(name), None


def create_note(title, near=None):
    """New note named after `title`. It lands next to the `near` note's team when that note
    lives in a department, else in <brain>/notes/, and links back so it joins the graph."""
    title = " ".join(str(title or "").split())
    if not _TITLE.match(title):
        return None, "title: letters, numbers, spaces, - and _ only (max 80)"
    name = re.sub(r"\s+", "-", title).lower()
    notes = _notes()
    if any(n.lower() == name for n in notes):
        return None, "a note with that name already exists"
    folder = ROOT / "notes"
    anchor = notes.get(near) if near else None
    if anchor is not None:
        rel = anchor.relative_to(ROOT).parts
        if rel[0] == "departments" and len(rel) >= 3:
            folder = ROOT.joinpath(*rel[:3]) if len(rel) >= 4 else ROOT / "departments" / rel[1] / "notes"
    path = folder / f"{name}.md"
    if os.path.commonpath([path.resolve().parent, ROOT.resolve()]) != str(ROOT.resolve()):
        return None, "bad location"
    folder.mkdir(parents=True, exist_ok=True)
    back = f"Linked from [[{near}]]." if anchor is not None else "Part of [[Atlas]]."
    _atomic_write(path, f"# {title}\n\n{back}\n\n")
    return note(name), None


def add_link(source, target):
    """Add [[target]] to source's '## Links' section (made if missing). No-op if already linked."""
    notes = _notes()
    if source not in notes or target not in notes or source == target:
        return None, "both notes must exist and differ"
    path = notes[source]
    if path.stat().st_size > _MAX_NOTE:
        return None, "this note is too large to edit here"
    text = path.read_text(encoding="utf-8")
    if target in _links_in(text):
        return note(source), None
    m = re.search(r"^##\s+Links\s*$", text, re.M)
    if m:
        text = text[:m.end()] + f"\n- [[{target}]]" + text[m.end():]
    else:
        text = text.rstrip() + f"\n\n## Links\n- [[{target}]]\n"
    _atomic_write(path, text)
    return note(source), None


def suggestions(name, limit=12):
    """Unlinked mentions, both ways: notes whose text names `name` without linking it
    (mentioned_in), and notes `name` names in its own text without linking (mentions)."""
    notes = _notes()
    if name not in notes:
        return None
    texts, links = {}, {}
    for n, p in notes.items():
        try:
            raw = p.read_text(encoding="utf-8")[:_MAX_NOTE]
        except OSError:
            raw = ""
        links[n] = _links_in(raw)
        # prose only: "[[business-operations]]" is a link to one note, not a mention of "operations"
        texts[n] = re.sub(r"\[\[[^\]]*\]\]", lambda m: " " * len(m.group(0)), raw)

    def snippet(text, m):
        a, b = max(0, m.start() - 60), min(len(text), m.end() + 60)
        return ("…" if a else "") + " ".join(text[a:b].split()) + ("…" if b < len(text) else "")

    def worth(n):          # skip the hub and machine ids that never appear in prose
        return n != "Atlas" and not n.startswith("inbox-") and len(_norm(n)) >= 5

    mentioned_in, mentions = [], []
    rx = _phrase(name) if worth(name) else None
    own_links = links[name]
    for other, text in texts.items():
        if other == name:
            continue
        if rx and name not in links[other]:
            m = rx.search(text)
            if m:
                mentioned_in.append({"id": other, "snippet": snippet(text, m)})
        if worth(other) and other not in own_links:
            orx = _phrase(other)
            m = orx.search(texts[name]) if orx else None
            if m:
                mentions.append({"id": other, "snippet": snippet(texts[name], m)})
    longer_first = lambda x: -len(_norm(x["id"]))
    return {"id": name,
            "mentioned_in": sorted(mentioned_in, key=longer_first)[:limit],
            "mentions": sorted(mentions, key=longer_first)[:limit]}


# ── Inbox store (<brain>/inbox/) ─────────────────────────────────────────────
def inbox_dir():
    return ROOT / "inbox"


def _index_path():
    return inbox_dir() / "index.json"


def _load_index():
    p = _index_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except (OSError, ValueError):
        pass
    return []


def _save_index(items):
    d = inbox_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f".index.{uuid.uuid4().hex[:8]}.tmp"
    tmp.write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, _index_path())


def sanitize_filename(raw, default_ext=".txt"):
    """Strip path components and unsafe chars; reject executable extensions."""
    name = pathlib.Path(str(raw or "").replace("\\", "/")).name
    name = _SAFE_NAME.sub("-", name).strip(".-")
    if not name:
        name = "note" + default_ext
    stem = pathlib.Path(name).stem[:64] or "item"
    ext = pathlib.Path(name).suffix.lower()[:12]
    if not ext:
        ext = default_ext
    if ext in _BLOCKED_EXTS or (ext not in _ALLOWED_EXTS):
        raise ValueError(f"unsupported or unsafe file type: {ext}")
    return f"{stem}{ext}", stem, ext


def _propose_triage(name, kind, preview):
    """Heuristic auto-triage proposal (read-only suggestion; never auto-executes)."""
    blob = f"{name} {preview}".lower()
    if kind == "csv" or any(w in blob for w in ("roas", "ctr", "ad spend", "impressions", "orders", "conversion", "analytics")):
        return {"department": "marketing", "team": "analytics",
                "action": "Score test batch & flag kill/scale candidates"}
    if any(w in blob for w in ("margin", "price", "cost", "budget", "tax", "invoice", "refund", "cash")):
        return {"department": "finance", "team": "pricing",
                "action": "Check unit economics & contribution margin gate"}
    if any(w in blob for w in ("hoodie", "shirt", "tee", "mug", "mockup", "journal", "tracker", "diary", "pod", "design")):
        return {"department": "design-content", "team": "pod-design",
                "action": "Review concept & prepare listing angles"}
    if any(w in blob for w in ("shopify", "fulfil", "supplier", "shipping", "cutoff", "order", "store")):
        return {"department": "business-operations", "team": "shopify-store",
                "action": "File under store operations & check cutoff impact"}
    if any(w in blob for w in ("trademark", "copyright", "policy", "legal", "terms", "compliance")):
        return {"department": "business-operations", "team": "legal-compliance",
                "action": "Run trademark & platform policy check"}
    return {"department": "research-strategy", "team": "strategy",
            "action": "Summarise & link into the Atlas second brain"}


def _ensure_inbox_hub():
    """Ensure <brain>/inbox/inbox.md exists and links to [[Atlas]] so the inbox
    cluster sits cleanly in the Brain graph."""
    d = inbox_dir()
    d.mkdir(parents=True, exist_ok=True)
    hub = d / "inbox.md"
    if not hub.exists():
        hub.write_text(
            "# Inbox\n\nPart of [[Atlas]]. Dropped files, CSVs, and quick notes land here "
            "and link into the second brain.\n",
            encoding="utf-8",
        )


def inbox_list():
    """Return all non-discarded inbox items (newest first) plus storage path."""
    d = inbox_dir()
    items = _load_index()
    items.sort(key=lambda x: -(x.get("created") or 0))
    return {"items": items, "root": str(d), "exists": d.is_dir()}


def inbox_save(payload):
    """Save a dropped file, CSV, or quick note into <brain>/inbox/ and create a
    companion markdown note linked to [[Atlas]] (and any target department) so
    the Brain graph grows from every drop.

    Returns (item_dict, error_string_or_None).
    """
    if not isinstance(payload, dict):
        return None, "payload must be a JSON object"

    raw_name = (payload.get("name") or payload.get("title") or "").strip()
    text_content = payload.get("content")
    b64_data = payload.get("data_base64")
    kind_hint = (payload.get("kind") or payload.get("type") or "").strip().lower()
    dept = (payload.get("department") or "").strip().lower()
    note_comment = (payload.get("note") or "").strip()

    if text_content is None and not b64_data and not raw_name:
        return None, "nothing to save (provide content, data_base64, or name)"

    default_ext = ".csv" if kind_hint == "csv" else ".md" if kind_hint == "note" else ".txt"
    if not raw_name:
        snippet = re.sub(r"[^A-Za-z0-9]+", "-", (str(text_content or "quick-note"))[:32]).strip("-").lower() or "quick-note"
        raw_name = f"{snippet}{default_ext}"

    try:
        clean_name, stem, ext = sanitize_filename(raw_name, default_ext=default_ext)
    except ValueError as e:
        return None, str(e)

    raw_bytes = b""
    text_preview = ""
    if b64_data:
        try:
            # Strip optional data:...;base64, prefix
            if "," in b64_data and b64_data.lstrip().startswith("data:"):
                b64_data = b64_data.split(",", 1)[1]
            raw_bytes = base64.b64decode(b64_data, validate=False)
        except Exception:
            return None, "invalid base64 data"
        if len(raw_bytes) > _MAX_INBOX_BYTES:
            return None, f"file exceeds {_MAX_INBOX_BYTES} byte limit"
        if ext in {".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".html", ".xml"}:
            text_preview = raw_bytes.decode("utf-8", "replace")[:4000]
    else:
        text_str = str(text_content or "")
        raw_bytes = text_str.encode("utf-8")
        if len(raw_bytes) > _MAX_INBOX_BYTES:
            return None, f"content exceeds {_MAX_INBOX_BYTES} byte limit"
        text_preview = text_str[:4000]

    _ensure_inbox_hub()
    d = inbox_dir()
    short_id = uuid.uuid4().hex[:6]
    slug_base = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")[:40] or "item"
    item_id = f"inbox-{slug_base}-{short_id}"
    note_id = item_id

    # Store original file if it is not already the markdown note itself
    stored_file = f"{item_id}{ext}"
    file_path = d / stored_file
    md_path = d / f"{note_id}.md"
    if md_path == file_path:
        # .md drops would be overwritten by the companion note: keep the original
        # under its own name so the full content survives the triage note.
        stored_file = f"{item_id}-source{ext}"
        file_path = d / stored_file
    file_path.write_bytes(raw_bytes)

    if ext == ".csv" or kind_hint == "csv":
        item_kind = "csv"
    elif ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        item_kind = "image"
    elif ext == ".pdf":
        item_kind = "pdf"
    elif kind_hint == "url" or (text_preview.strip().startswith(("http://", "https://")) and "\n" not in text_preview.strip()):
        item_kind = "url"
    elif kind_hint == "note" or ext == ".md":
        item_kind = "note"
    else:
        item_kind = "file"

    triage = _propose_triage(clean_name, item_kind, text_preview)
    target_dept = dept if dept in _ORDER else triage["department"]
    target_team = triage["team"]

    # Build a summary / CSV preview for the companion Brain markdown note
    csv_summary = ""
    if item_kind == "csv" and text_preview:
        lines = [ln for ln in text_preview.splitlines() if ln.strip()]
        headers = lines[0] if lines else ""
        row_count = max(0, len(lines) - 1)
        csv_summary = f"\n## CSV structure\n- Rows (sampled): {row_count}\n- Columns: `{headers[:240]}`\n"

    links = ["[[Atlas]]", "[[inbox]]"]
    if target_dept:
        links.append(f"[[{target_dept}]]")
    if target_team:
        links.append(f"[[{target_team}]]")
    # Also preserve any explicit [[wikilinks]] the user wrote in the note
    for lk in _LINK.findall(text_preview):
        tok = f"[[{lk.strip()}]]"
        if tok not in links:
            links.append(tok)

    ts_human = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    body_excerpt = (text_preview.strip()[:2500] if text_preview.strip()
                    else f"Binary {item_kind} file ({len(raw_bytes)} bytes) saved as `{stored_file}`.")
    md_text = (
        f"# {clean_name}\n\n"
        f"- **Inbox ID:** `{item_id}`\n"
        f"- **Kind:** {item_kind}\n"
        f"- **Saved:** {ts_human}\n"
        f"- **File:** `inbox/{stored_file}` ({len(raw_bytes)} bytes)\n"
        f"- **Proposed triage:** {triage['action']} → [[{target_team}]] (in [[{target_dept}]])\n"
        f"- **Links:** {' '.join(links)}\n"
        + (f"- **Note:** {note_comment}\n" if note_comment else "")
        + csv_summary
        + f"\n## Content\n\n{body_excerpt}\n"
    )
    md_path.write_text(md_text, encoding="utf-8")

    item = {
        "id": item_id,
        "name": clean_name,
        "kind": item_kind,
        "size": len(raw_bytes),
        "created": time.time(),
        "status": "filed" if dept else "new",
        "path": f"inbox/{stored_file}",
        "note_id": note_id,
        "note_path": f"inbox/{note_id}.md",
        "preview": text_preview[:280].strip(),
        "triage": {
            "department": target_dept,
            "team": target_team,
            "action": triage["action"],
        },
    }
    items = [x for x in _load_index() if x.get("id") != item_id]
    items.append(item)
    _save_index(items)
    return item, None


def inbox_action(payload):
    """Update an inbox item's status or file it into a department, or discard it.
    Returns (updated_item_or_dict, error_or_None).
    """
    if not isinstance(payload, dict):
        return None, "payload must be a JSON object"
    item_id = str(payload.get("id") or "").strip()
    action = str(payload.get("action") or "").strip().lower()
    if not _SAFE_ID.match(item_id):
        return None, "invalid inbox item id"
    if action not in ("file", "status", "discard"):
        return None, "action must be 'file', 'status', or 'discard'"

    items = _load_index()
    target = next((x for x in items if x.get("id") == item_id), None)
    if not target:
        return None, "inbox item not found"

    d = inbox_dir()
    if action == "discard":
        items = [x for x in items if x.get("id") != item_id]
        _save_index(items)
        for rel in (target.get("path"), target.get("note_path")):
            if rel:
                p = (ROOT / rel).resolve()
                if os.path.commonpath([p, d.resolve()]) == str(d.resolve()):
                    p.unlink(missing_ok=True)
        return {"id": item_id, "discarded": True}, None

    if action == "file":
        dept = str(payload.get("department") or target.get("triage", {}).get("department") or "research-strategy").strip().lower()
        team = str(payload.get("team") or target.get("triage", {}).get("team") or "").strip().lower()
        target["status"] = "filed"
        target.setdefault("triage", {})["department"] = dept
        if team:
            target["triage"]["team"] = team
        # Ensure the markdown note links to the chosen department/team
        md_path = d / f"{target['note_id']}.md"
        if md_path.is_file():
            try:
                txt = md_path.read_text(encoding="utf-8")
                add_links = [f"[[{dept}]]"] + ([f"[[{team}]]"] if team else [])
                for lk in add_links:
                    if lk not in txt:
                        txt = txt.rstrip() + f"\n- Filed to {lk}\n"
                md_path.write_text(txt, encoding="utf-8")
            except OSError:
                pass
    elif action == "status":
        st = str(payload.get("status") or "reading").strip().lower()
        if st not in ("new", "reading", "filed", "needs-question"):
            return None, "invalid status"
        target["status"] = st

    _save_index(items)
    return target, None
