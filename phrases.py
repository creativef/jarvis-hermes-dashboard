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


def say(group, fallback="", **slots):
    """pick() with the {slots} filled in: say("time", time="14:05", day="Saturday")."""
    line = pick(group, fallback)
    try:
        return line.format(**slots)
    except (KeyError, IndexError, ValueError):       # a hand edit dropped or mistyped a slot
        return fallback.format(**slots) if fallback else line


# ── the library changes by voice: retire a line, take on new ones ──
CANDIDATES = FILE.with_name("logs") / "phrase-candidates.json"
USAGE = FILE.with_name("logs") / "phrase-usage.json"
last_spoken = ""         # the stock line the dashboard last said out loud (the UI reports it)


def heard(line):
    """The page reports the stock line it last SAID (a holding line is picked every turn but
    only spoken when the answer is slow). Remember it for "don't say that again", and count
    it once, so retiring an over-used line rests on numbers, not on a hunch."""
    global last_spoken
    line = " ".join(str(line or "").split())[:200]
    if not line or line == last_spoken:
        last_spoken = line
        return
    last_spoken = line
    if not any(line in pool for group, pool in all_lines().items() if group != "never_say"):
        return                                    # a filled-in line or job news text: not countable
    with _lock:
        counts = usage()
        counts[line] = counts.get(line, 0) + 1
        try:
            USAGE.parent.mkdir(parents=True, exist_ok=True)
            tmp = USAGE.with_name("." + USAGE.name + ".tmp")
            tmp.write_text(json.dumps(counts, indent=1, ensure_ascii=False), encoding="utf-8")
            tmp.replace(USAGE)
        except OSError:
            pass


def usage():
    """{line: times spoken}."""
    try:
        raw = json.loads(USAGE.read_text(encoding="utf-8"))
        return {str(k): int(v) for k, v in raw.items()} if isinstance(raw, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def retired():
    try:
        return {s.strip() for s in json.loads(FILE.read_text(encoding="utf-8")).get("retired", []) if isinstance(s, str)}
    except (OSError, ValueError, AttributeError):
        return set()


def _rewrite(change):
    """Apply `change(raw)` to phrases.json and save it, atomically."""
    with _lock:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
        change(raw)
        tmp = FILE.with_name("." + FILE.name + ".tmp")
        tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(FILE)
        _data["mtime"] = None                     # read it back at once, even within the clock's tick


def retire(line):
    """Stop a stock line being said (it moves to "retired"). True if it was a stock line."""
    line = " ".join(str(line or "").split())
    if not line or not any(line in pool for group, pool in all_lines().items() if group != "never_say"):
        return False
    _rewrite(lambda raw: raw.setdefault("retired", []).append(line) if line not in raw.get("retired", []) else None)
    return True


def candidates():
    """{group: [new lines]} a helper proposed, cleaned: known groups, plain short lines, nothing we already say."""
    try:
        raw = json.loads(CANDIDATES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    have, gone = all_lines(), retired()           # a retired line must not come back as "new"
    out = {}
    for group, pool in (raw.items() if isinstance(raw, dict) else []):
        if group not in have or group == "never_say" or not isinstance(pool, list):
            continue
        slots = set(re.findall(r"\{\w+\}", " ".join(have[group])))
        keep = []
        for s in pool:
            s = " ".join(str(s).split())
            if (3 <= len(s) <= 110 and not re.search(r"[*_#`<>]", s) and s not in have[group] and s not in gone and s not in keep
                    and set(re.findall(r"\{\w+\}", s)) <= slots):
                keep.append(s)
        if keep:
            out[group] = keep[:8]
    return out


def keep_candidates():
    """Take the proposed lines into the library. Returns how many were added."""
    new = candidates()
    if new:
        _rewrite(lambda raw: [raw.setdefault(g, []).extend(v) for g, v in new.items()])
    drop_candidates()
    return sum(len(v) for v in new.values())


def drop_candidates():
    try:
        CANDIDATES.unlink()
    except OSError:
        pass


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
                   r"book|schedule|put|move|delete|remove|rename|generate|design|turn|play|save|check|pull|list|read|compare|"
                   r"remind|cancel|stop|post|upload|edit|clean|sort|organi[sz]e|prepare|order)\b", re.I)
_QUESTION = re.compile(r"^(?:what|what's|whats|who|who's|where|when|why|how|which|is|are|was|were|"
                       r"do|does|did|can|could|should|would|will|have|has|any)\b", re.I)


# Talk, not a task: a holding line here ("Just a jiffy." to "thank you") sounds like nobody is listening.
_CHAT = re.compile(r"^(?:good\s+(?:morning|afternoon|evening|night)|morning|evening|hello|hi|hey|thanks?|thank\s+you|cheers|"
                   r"yes|yeah|yep|no|nope|ok(?:ay)?|sure|fine|brilliant|great|lovely|nice|perfect|wow|oh|well|sorry|"
                   r"how\s+are\s+you|how\s+you|how(?:'s|\s+is)\s+(?:it|things|life|your)|how\s+do\s+you\s+feel|how\s+was|"
                   r"are\s+you\s+(?:there|here|awake|ok)|so\s+good|good\s+to|nice\s+to|i(?:'m|\s+am)\s+(?:back|here|tired|done))\b", re.I)


def ack(message):
    """A holding line suited to the request, or "" (say nothing): now and then, and always
    for small talk, where the reply itself should be the first thing he hears."""
    text = _WAKE.sub("", message or "").strip()
    if _CHAT.match(text) or len(text.split()) <= 1:
        return ""
    if random.random() < SILENCE:
        return ""
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


_SIR_TAIL = re.compile(r"(?:,\s*|\s+)sir(?=\s*[.!?,;]|\s*$)", re.I)    # "Done, sir." / "Yes sir!"
_SIR_HEAD = re.compile(r"^\s*sir[,!]\s*", re.I)                         # "Sir, the build passed."


def tidy(sentence):
    """A spoken sentence minus what Atlas must never say: being called "sir", and a
    never_say phrase used as an opener ("Certainly, here it is." -> "Here it is.").
    "" if nothing is left. Only openers are trimmed: "Absolutely not." stays as it is."""
    s = _SIR_HEAD.sub("", _SIR_TAIL.sub("", sentence or ""))
    for phrase in lines("never_say"):
        m = re.match(r"\s*" + re.escape(phrase.rstrip(".!?")) + r"(?:\s*[,.!:;\u2014\u2013-]+\s*|\s*$)", s, re.I)
        if m:
            s = s[m.end():]
            break
    if s == sentence:
        return s
    s = s.strip()
    return s[:1].upper() + s[1:]


def never_say_block():
    """Prompt block with the never-say list. It must not change from turn to turn: the
    persona sits early in the prompt, and any change there makes the provider re-read the
    whole conversation uncached (slower first word, higher cost)."""
    banned = lines("never_say")
    if not banned:
        return ""
    return ("## Never say\n" + ", ".join(f'"{b}"' for b in banned)
            + ". Never call him sir. Never open two replies in a row the same way.")


def prewarm_lines():
    """Lines worth recording in advance so they play instantly."""
    groups = ("ack", "ack_question", "ack_task", "ack_lookup", "long_wait", "longer_wait",
              "handoff", "didnt_catch", "error", "noted", "cleared", "fresh", "nothing_running")
    with _lock:
        data = _load()
        return [line for g in groups for line in data.get(g, [])]
