"""Morning brief data: today's business pulse and calendar.

A quiet helper job (tools/handoff.py) asks Hermes to gather them READ-ONLY with whatever
you've connected there (Shopify, Etsy, ad accounts, a calendar…) and to write
logs/brief/<date>.json. One fetch at a time; the brief starts one by itself once a day
(unless the last one found nothing connected), and ↻ asks for a fresh one.
"""
import datetime
import json
import pathlib
import re
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent
BRIEF_DIR = ROOT / "logs" / "brief"
_LOCK = threading.Lock()
_MAX_ITEMS = 8
_KEEP_DAYS = 14

PROMPT = """Fetch the data for the Atlas dashboard's morning brief. READ ONLY: do not change, send, post or buy anything, and do not install or connect anything new. Use only tools and integrations you already have connected (store or e-commerce platforms such as Shopify or Etsy, ad accounts, calendars).

1. Business pulse: for each store you can reach, orders and revenue yesterday and so far today; ad spend yesterday if an ad account is connected.
2. Calendar: events today and the next 3 days, plus birthdays or important dates in the next 14 days.

Then write a JSON file at exactly this path (create the folder, overwrite the file):
{path}

with exactly this shape:
{{"business": [{{"label": "Etsy orders today", "value": "4 · $96"}}],
  "calendar": [{{"when": "Tue 10:00", "what": "Dentist"}}],
  "missing": ["Calendar: not connected"]}}

Keep every label, value, when and what under 40 characters. If a source is not connected or fails, leave its list empty and say so briefly in "missing". Never put secrets, emails or account numbers in the file."""


def _today():
    return datetime.date.today().isoformat()


def _paths(day):
    return BRIEF_DIR / f"{day}.json", BRIEF_DIR / f"{day}.job"


def _short(v, n):
    return " ".join(str(v or "").split())[:n]


def _rows(items, keys):
    out = []
    for it in items if isinstance(items, list) else []:
        if isinstance(it, dict):
            row = {k: _short(it.get(k), 60) for k in keys}
            if any(row.values()):
                out.append(row)
        if len(out) >= _MAX_ITEMS:
            break
    return out


def _read(path):
    """The brief file Hermes wrote, cleaned and size-capped; None if missing or unreadable."""
    try:
        text = path.read_text(encoding="utf-8")[:50_000]
        fetched = path.stat().st_mtime
    except OSError:
        return None
    try:
        raw = json.loads(text)
    except ValueError:                       # tolerate a ```json fence or a stray sentence
        m = re.search(r"\{.*\}", text, re.S)
        try:
            raw = json.loads(m.group(0)) if m else None
        except ValueError:
            raw = None
    if not isinstance(raw, dict):
        return None
    missing = raw.get("missing") if isinstance(raw.get("missing"), list) else []
    return {"business": _rows(raw.get("business"), ("label", "value")),
            "calendar": _rows(raw.get("calendar"), ("when", "what")),
            "missing": [_short(m, 120) for m in missing if m][:6],
            "fetched": fetched}


def _job(day):
    """The helper job record started for `day`, if any."""
    try:
        jid = _paths(day)[1].read_text(encoding="utf-8").strip()
        import commands
        return json.loads((commands.HANDOFF_DIR / f"{jid}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _nothing_connected_last_time(day):
    """True when the most recent earlier brief found no store and no calendar at all."""
    older = sorted(p for p in BRIEF_DIR.glob("*.json") if p.stem < day) if BRIEF_DIR.is_dir() else []
    last = _read(older[-1]) if older else None
    return bool(last) and not last["business"] and not last["calendar"]


def state():
    """{date, status: none|running|ready|failed, data, error, auto} for the brief cards."""
    day = _today()
    data = _read(_paths(day)[0])
    job = _job(day)
    running = bool(job and job.get("status") == "running")
    status = "running" if running else "ready" if data else "failed" if job else "none"
    error = ""
    if status == "failed":
        error = _short(job.get("result") or "Hermes didn't write the brief.", 240)
    return {"date": day, "status": status, "data": data, "error": error,
            "auto": status == "none" and not _nothing_connected_last_time(day)}


def _prune():
    cutoff = (datetime.date.today() - datetime.timedelta(days=_KEEP_DAYS)).isoformat()
    for p in BRIEF_DIR.glob("*"):
        if p.stem < cutoff:
            try:
                p.unlink()
            except OSError:
                pass


def start(force=False):
    """Start today's fetch. Without `force` only when the brief would auto-start
    (nothing yet today, and the last fetch found something connected)."""
    with _LOCK:
        st = state()
        if st["status"] == "running" or (not force and not st["auto"]):
            return st
        BRIEF_DIR.mkdir(parents=True, exist_ok=True)
        _prune()
        data_path, job_path = _paths(st["date"])
        from tools import handoff
        jid = handoff.launch(PROMPT.format(path=data_path), quiet=True)
        job_path.write_text(jid, encoding="utf-8")
        time.sleep(0.05)                     # let the job file land before we report on it
        return state()
