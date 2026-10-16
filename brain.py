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
