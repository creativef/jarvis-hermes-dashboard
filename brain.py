"""
Read-only view of the Atlas second brain (a folder of linked markdown notes).

Builds a graph from [[wikilinks]] so the dashboard can draw it, and serves a
single note's text on request. Nothing here writes to disk, and note lookups go
by note name only (never a caller-supplied path), so the API cannot be used to
read files outside the brain folder.
"""
import os
import pathlib
import re

ROOT = pathlib.Path(os.environ.get("ATLAS_BRAIN", "~/Atlas")).expanduser()
_LINK = re.compile(r"\[\[([^\]|#]+)")
_MAX_NOTE = 200_000


def _notes():
    """{name: Path} for every markdown note in the brain (first one wins)."""
    out = {}
    if not ROOT.is_dir():
        return out
    for p in sorted(ROOT.rglob("*.md")):
        if any(part.startswith(".") for part in p.relative_to(ROOT).parts):
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


def graph():
    notes = _notes()
    nodes, edges, seen = [], [], set()
    for name, path in notes.items():
        kind, group = _classify(name, path)
        if kind == "other":          # README and stray notes would only float unconnected
            continue
        nodes.append({"id": name, "type": kind, "group": group})
        try:
            text = path.read_text(encoding="utf-8")[:_MAX_NOTE]
        except OSError:
            continue
        for tgt in set(m.strip() for m in _LINK.findall(text)):
            if tgt in notes and tgt != name:
                key = tuple(sorted((name, tgt)))
                if key not in seen:
                    seen.add(key)
                    edges.append({"source": name, "target": tgt})
    return {"nodes": nodes, "links": edges, "root": str(ROOT), "exists": ROOT.is_dir()}


def note(name):
    path = _notes().get(name)
    if path is None:
        return None
    try:
        text = path.read_text(encoding="utf-8")[:_MAX_NOTE]
    except OSError:
        return None
    return {"id": name, "path": str(path.relative_to(ROOT)), "text": text}
