"""Atlas's stock spoken lines (holding lines, long-wait lines, greetings, job news).

They live in phrases.json so they can grow without touching code; the file is re-read
when it changes. Each group is dealt like a shuffled deck, so a line never comes back
until the rest of its group has played, and never twice in a row across reshuffles.
"""
import json
import pathlib
import random
import re
import threading

FILE = pathlib.Path(__file__).resolve().parent / "phrases.json"
SILENCE = 0.2            # share of turns with no holding line at all: not every task needs announcing
LONG_WAIT_MS = (7000, 16000)   # "still at it" lines, if the answer still hasn't started

_lock = threading.RLock()
_data = {"mtime": None, "lines": {}}
_decks, _last = {}, {}
on_change = None         # set by the server: re-record new lines in the Kokoro voice


def _load():
    try:
        mtime = FILE.stat().st_mtime
    except OSError:
        return _data["lines"]
    if mtime == _data["mtime"]:
        return _data["lines"]
    try:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _data["lines"]                    # mid-edit or a typo: keep the last good copy
    retired = {s.strip() for s in raw.get("retired", []) if isinstance(s, str)}
    lines = {k: [s.strip() for s in v if isinstance(s, str) and s.strip() and s.strip() not in retired]
             for k, v in raw.items() if isinstance(v, list) and k != "retired"}
    reloaded = _data["mtime"] is not None
    _data.update(mtime=mtime, lines=lines)
    _decks.clear()
    if reloaded and on_change:
        on_change()
    return lines


def lines(group):
    with _lock:
        return list(_load().get(group, []))


def all_lines():
    with _lock:
        return {k: list(v) for k, v in _load().items()}


def pick(group, fallback=""):
    """Next line from a group, shuffled-deck style. `fallback` if the group is empty."""
    with _lock:
        pool = _load().get(group) or []
        if not pool:
            return fallback
        deck = _decks.get(group)
        if not deck:
            deck = pool[:]
            random.shuffle(deck)
            if len(deck) > 1 and deck[-1] == _last.get(group):   # no repeat across reshuffles
                deck[0], deck[-1] = deck[-1], deck[0]
            _decks[group] = deck
        line = deck.pop()
        _last[group] = line
        return line


_WAKE = re.compile(r"^\s*(?:hey\s+atlas|ok\s+atlas|atlas|jarvis)[,:\s]+", re.I)
_POLITE = re.compile(r"^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?", re.I)
_LOOKUP = re.compile(r"\b(?:look\s+(?:up|into|for)|find|search|research|dig\s+into)\b", re.I)
_TASK = re.compile(r"^(?:make|create|build|write|draft|send|add|set|update|fix|change|open|run|start|"
                   r"book|schedule|put|move|delete|remove|rename|generate|design|turn|play|save|"
                   r"remind|cancel|stop|post|upload|edit|clean|sort|organi[sz]e|prepare|order)\b", re.I)
_QUESTION = re.compile(r"^(?:what|what's|whats|who|who's|where|when|why|how|which|is|are|was|were|"
                       r"do|does|did|can|could|should|would|will|have|has|any)\b", re.I)


def ack(message):
    """A holding line suited to the request, or "" (say nothing) now and then."""
    if random.random() < SILENCE:
        return ""
    text = _WAKE.sub("", message or "").strip()
    asked = _POLITE.sub("", text)
    if _LOOKUP.search(text[:80]):
        group = "ack_lookup"
    elif _TASK.match(asked):
        group = "ack_task"
    elif _QUESTION.match(text) or text.endswith("?"):
        group = "ack_question"
    else:
        group = "ack"
    return pick(group) or pick("ack")


def long_waits():
    """[(ms, line), ...] to say if the answer still hasn't started by then."""
    return [[ms, line] for ms, line in zip(LONG_WAIT_MS, (pick("long_wait"), pick("longer_wait"))) if line]


def prewarm_lines():
    """Lines worth recording in advance so they play instantly."""
    groups = ("ack", "ack_question", "ack_task", "ack_lookup", "long_wait", "longer_wait",
              "handoff", "didnt_catch")
    with _lock:
        data = _load()
        return [line for g in groups for line in data.get(g, [])]
