"""
Command matrix for the Hermes-backed JARVIS dashboard.

Local commands keep the HUD fast for mission control/status while prompts and
unknown slash commands are handed to Hermes Agent. Hermes-native tool access comes
from the runtime subprocess (`hermes chat -q ...`) using the configured profile.
"""
import copy
import datetime
import json
import os
import pathlib
import re
import signal
import subprocess
import threading
import time
import uuid

import brain
import delegations
import phrases

ROOT = pathlib.Path(__file__).resolve().parent
STATE_FILE = pathlib.Path(os.environ.get("JARVIS_STATE", ROOT / "state.json"))
_LOCK = threading.Lock()
_DEFAULT = {"profile": [], "goal": "", "personality": "", "tasks": [], "session": None, "history": [], "settings": {}}


def _load_unlocked(for_update=False):
    """The saved state, or defaults when there is none yet.

    Defaults are only safe to SAVE when the file really is absent. A file that exists but
    could not be read (permissions, too many open files) or parsed (a hand edit with a typo)
    used to load as defaults too, and the next save wrote those over it: history, settings
    and the Hermes thread gone without a word. Now an unreadable file stops the update, and
    an unparseable one is set aside as state.json.bad before anything is written."""
    try:
        text = STATE_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return copy.deepcopy(_DEFAULT)      # never hand out the shared default lists
    except OSError:
        if for_update:
            raise
        return copy.deepcopy(_DEFAULT)
    try:
        d = json.loads(text)
        if not isinstance(d, dict):
            raise ValueError("state is not a JSON object")
    except ValueError:
        try:
            os.replace(STATE_FILE, STATE_FILE.with_name(STATE_FILE.name + ".bad"))
        except OSError:
            if for_update:
                raise
        return copy.deepcopy(_DEFAULT)
    return {**copy.deepcopy(_DEFAULT), **d}


def load():
    with _LOCK:
        return _load_unlocked()


def write_atomic(path, text):
    """Write text atomically (tmp + os.replace). A crash mid-write would otherwise leave
    truncated JSON, and every reader silently skips unparseable files — so the job would
    vanish from the announcement queue entirely."""
    path = pathlib.Path(path)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def _save_unlocked(d):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(STATE_FILE, json.dumps(d, indent=2) + "\n")


def update_state(mutator):
    """Apply one read-modify-write transaction without losing concurrent updates."""
    with _LOCK:
        d = _load_unlocked(for_update=True)
        result = mutator(d)
        _save_unlocked(d)
        return result


def set_session(sid):
    update_state(lambda d: d.update(session=sid))


def get_session():
    return load().get("session")


def record_turn(user, assistant):
    def _append(d):
        d.setdefault("history", []).append({"user": user, "assistant": assistant, "ts": time.time()})
        d["history"] = d["history"][-200:]
    update_state(_append)


def get_history():
    return load().get("history", [])


def clear_history():
    update_state(lambda d: d.update(history=[]))


def get_settings():
    return load().get("settings", {})


# How much Atlas says, set in Settings or by voice ("keep it brief", "talk me through things").
# The words go into the persona, so they change only when the setting does (prompt cache).
TALK = {
    "brief": "## How much to say, for now\nHe has asked for short answers for the time being: one or two "
             "sentences for everything, whatever the ranges above say, unless he asks for more.",
    "normal": "",
    "chatty": "## How much to say, for now\nHe has asked you to talk things through: lean to the fuller end "
              "of every range above, think out loud, bring in what you remember from earlier, and always hand "
              "the conversation back to him.",
}


def talk_block():
    return TALK.get(str(get_settings().get("talk") or "normal"), "")


def set_settings(updates):
    """Validate + persist settings. Returns (cleaned_settings, error)."""
    cleaned = {}
    if "permission" in updates:
        perm = str(updates["permission"]).strip().lower()
        if perm not in ("normal", "bypass", "default"):
            return None, f"invalid permission: {perm}"
        cleaned["permission"] = perm
    if "timeout" in updates:
        try:
            t = int(updates["timeout"])
        except (TypeError, ValueError):
            return None, "timeout must be an integer number of seconds"
        if not (10 <= t <= 3600):
            return None, "timeout must be between 10 and 3600 seconds"
        cleaned["timeout"] = t
    if "workdir" in updates:
        wd = str(updates["workdir"]).strip() or "~"
        wd = os.path.expanduser(wd)
        if not os.path.isdir(wd):
            return None, f"workdir is not a directory: {wd}"
        cleaned["workdir"] = wd

    if "user_name" in updates:
        name = " ".join(str(updates["user_name"]).split())[:40]
        cleaned["user_name"] = name
    if "model_provider" in updates:
        # Provider id as Hermes names it (e.g. "openrouter", "custom", "custom:local").
        # Empty is allowed: it means "use Hermes' own configured default".
        prov = str(updates["model_provider"] or "").strip()
        if prov and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", prov):
            return None, f"invalid provider: {prov}"
        cleaned["model_provider"] = prov
    if "model_name" in updates:
        # A model id as the provider names it (e.g. "anthropic/claude-opus-5.5"). Empty
        # is allowed and means "no --model override".
        mod = str(updates["model_name"] or "").strip()
        if mod and not re.fullmatch(r"[A-Za-z0-9._:/@+ -]{1,120}", mod):
            return None, f"invalid model: {mod}"
        cleaned["model_name"] = mod
    if "greeting" in updates:
        cleaned["greeting"] = bool(updates["greeting"])
    if "voice" in updates:
        v = str(updates["voice"]).strip()
        if not re.fullmatch(r"[a-z]{2}_[a-z]+", v):
            return None, f"invalid voice: {v}"
        cleaned["voice"] = v
    if "talk" in updates:
        talk = str(updates["talk"]).strip().lower()
        if talk not in TALK:
            return None, f"invalid talk setting: {talk}"
        cleaned["talk"] = talk
    if "voice_speed" in updates:
        import voice
        try:
            sp = round(float(updates["voice_speed"]), 2)
        except (TypeError, ValueError):
            return None, "voice speed must be a number"
        if not (voice.SPEED_MIN <= sp <= voice.SPEED_MAX):
            return None, f"voice speed must be between {voice.SPEED_MIN} and {voice.SPEED_MAX}"
        cleaned["voice_speed"] = sp
    def _merge(d):
        d.setdefault("settings", {}).update(cleaned)
    update_state(_merge)
    return cleaned, None


def context_block():
    d = load()
    out = []
    if d["profile"]:
        out.append("## User profile notes from ATLAS dashboard\n" + "\n".join(f"- {x}" for x in d["profile"][-40:]))
    if d["goal"]:
        out.append(f"## Standing objective\n{d['goal']}\nKeep it in mind; mention it only when relevant.")
    if d["personality"]:
        out.append(f"## Tone overlay\n{d['personality']}\nThis adjusts how you say things, not what is true.")
    open_tasks = [t for t in d["tasks"] if not t.get("done")]
    if open_tasks:
        out.append("## Mission queue\n" + "\n".join(f"- {t['text']}" for t in open_tasks[:20]))
    return "\n\n".join(out)


# Background work = detached tools/handoff.py helpers. They survive dashboard
# restarts and log progress; /background launches one too.
HANDOFF_DIR = ROOT / "logs" / "handoff"
_JOB_LOCK = threading.Lock()          # two polling tabs must not both announce one job
_KEEP_REPORTED_S = 30 * 86400          # announced jobs older than this are pruned


def _handoff_jobs():
    """Jobs launched by tools/handoff.py (detached processes that survive restarts)."""
    out = []
    try:
        paths = sorted(HANDOFF_DIR.glob("*.json"))
    except OSError:
        return out
    for path in paths:
        try:
            j = json.loads(path.read_text(encoding="utf-8"))
            j["_path"] = str(path)
            out.append(j)
        except (OSError, ValueError):
            continue
    return out


def jobs_snapshot():
    return [{k: v for k, v in j.items() if k != "_path"} for j in running_jobs()]


# A job file keeps saying "running" long after its worker is gone (reboot, kill, OOM).
# Only the Agents tab used to notice, so /status, the job count and the morning brief all
# counted a ghost forever. Liveness is decided in one place, from processes, not from the
# job file's own claim.
_PIDS_TTL = 5.0                      # `ps` is not free and these readers are polled
_PIDS_CACHE = {"at": 0.0, "pids": {}}
_WORKER_GRACE_S = 15                 # a just-launched worker may predate the cached `ps` list


def _live_worker_pids():
    """{job id: pid} of live `handoff.py --worker <id>` processes, cached briefly;
    None when `ps` itself failed.

    Matches the worker process itself, so a recycled pid belonging to some unrelated
    process can never make a dead job look alive."""
    now = time.time()
    if now - _PIDS_CACHE["at"] >= _PIDS_TTL:
        _PIDS_CACHE.update(at=now, pids=_worker_pids())
    return _PIDS_CACHE["pids"]


def _job_running(job, live):
    """True while a job that claims to be running actually has a worker behind it."""
    if job.get("status") != "running":
        return False
    if (job.get("id") or "") in (live or {}):
        return True
    if time.time() - (job.get("started") or 0) < _WORKER_GRACE_S:
        return True                  # just launched: the cached `ps` list may predate it
    if live is None:
        # `ps` failed, so the saved pid is all there is to go on.
        pid = job.get("pid")
        return bool(pid) and _pid_alive(pid)
    # `ps` answered and this worker is not in it: gone. Never trust the saved pid here —
    # after a reboot it often belongs to some unrelated process.
    return False


def job_is_live(job, live=None):
    return _job_running(job, _live_worker_pids() if live is None else live)


def running_jobs():
    """Genuinely running jobs; a dead worker is not counted as one."""
    jobs = _handoff_jobs()
    if not any(j.get("status") == "running" for j in jobs):
        return []
    live = _live_worker_pids()
    return [j for j in jobs if _job_running(j, live)]



def take_finished():
    """Finished helper jobs not announced yet, each returned exactly once.
    Also prunes long-announced jobs so the folder doesn't grow forever."""
    done, now = [], time.time()
    with _JOB_LOCK:
        for j in _handoff_jobs():
            path = pathlib.Path(j.pop("_path"))
            if j.get("reported"):
                if (j.get("finished") or now) < now - _KEEP_REPORTED_S:
                    for ext in (".json", ".log", ".err"):
                        try:
                            path.with_suffix(ext).unlink(missing_ok=True)
                        except OSError:
                            pass
                continue
            if j.get("status") == "running" and not job_is_live(j):
                # The worker died (reboot, kill) without recording an outcome: say so once,
                # instead of leaving a "running" ghost that is never announced or pruned.
                j.update(status="failed", result="The helper stopped unexpectedly.", finished=now)
            if j.get("status") not in ("done", "failed"):
                continue
            j["reported"] = True
            try:
                write_atomic(path, json.dumps(j))
            except OSError:
                continue
            if not j.get("quiet"):                 # quiet = internal fetches, e.g. the brief
                done.append(j)
    return done


_JID = re.compile(r"^[A-Za-z0-9]{1,32}$")


def _mark_stopped(path):
    with _JOB_LOCK:
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if job.get("status") == "running":
            job.update(status="stopped", result="Stopped by you.", finished=time.time(), reported=True)
            write_atomic(path, json.dumps(job))


def stop_job(jid):
    """Stop a running helper job. Only ever signals a process that `ps` shows is
    *that job's* worker (never a recycled pid). A worker that already died is just
    marked stopped. Returns (result, error)."""
    if not _JID.match(str(jid or "")):
        return None, "invalid job id"
    path = HANDOFF_DIR / f"{jid}.json"
    try:
        job = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, "no such job"
    if job.get("status") != "running":
        return None, "that job is not running"
    pid = (_worker_pids() or {}).get(jid)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)       # the worker stops Hermes and records "stopped"
        except ProcessLookupError:
            pid = None
        except PermissionError:
            return None, "not allowed to stop that process"
    if not pid:
        _mark_stopped(path)
        return {"id": jid, "stopped": True}, None

    def _escalate():
        time.sleep(10)
        if (_worker_pids() or {}).get(jid) == pid:     # still the same worker: force it
            try:
                os.killpg(pid, signal.SIGKILL)  # worker + its Hermes child (own session)
            except OSError:
                pass
        _mark_stopped(path)
    threading.Thread(target=_escalate, daemon=True).start()
    return {"id": jid, "stopping": True}, None


# ── Agents tab: every running / recent sub-agent job (read-only) ────────
def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError, ValueError):
        return False


def _worker_pids():
    """{job id: pid} of live `handoff.py --worker <id>` processes (covers jobs
    that started before pids were recorded in the job file). None when `ps` failed —
    which must not read the same as "ps answered: no workers"."""
    found = {}
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True,
                             text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+.*handoff\.py --worker (\w+)", line)
        if m:
            found[m.group(2)] = int(m.group(1))
    return found


def _last_log_line(jid):
    """(timestamp, text) of the newest progress line; reads only the file tail."""
    try:
        with open(HANDOFF_DIR / f"{jid}.log", "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4096))
            tail = f.read().decode("utf-8", "replace")
        lines = [ln for ln in tail.splitlines() if ln.strip()]
        ts, _, text = lines[-1].partition("\t")
        return float(ts), text
    except (OSError, IndexError, ValueError):
        return None, ""


def _agent_name(mission):
    m = " ".join((mission or "").split())
    if "diagnostic" in m.lower():
        return "Diagnostic agent"
    first = re.split(r"(?<=[.!?])\s", m, maxsplit=1)[0]
    first = re.sub(r"^(In|At|For) \S+,?\s+", "", first)
    if len(first) > 48:
        first = first[:48].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"
    return (first[:1].upper() + first[1:]) or "Sub-agent"


def agents_snapshot(limit=40):
    """Running and recent agents — dashboard helper jobs plus the platform's own
    delegated children, merged into one list the Agents tab renders. Never mutates job files."""
    now = time.time()
    jobs = []
    for j in _handoff_jobs():
        j.pop("_path", None)
        j["kind"] = "handoff"
        jobs.append(j)
    live = _live_worker_pids() if any(j.get("status") == "running" for j in jobs) else {}
    out = []
    for j in jobs:
        jid = j.get("id") or ""
        status = j.get("status") or "unknown"
        started, finished = j.get("started"), j.get("finished")
        step, step_at = "", None
        if j["kind"] == "handoff":
            step_at, step = _last_log_line(jid)
            if status == "running":
                if not _job_running(j, live):
                    status = "stalled"
                    step = step or "worker process is no longer running"
                elif not step:
                    step = "working… (no live output captured for this job)"
        mission = j.get("mission") or ""
        out.append(dict(
            id=jid, kind=j["kind"], name=_agent_name(mission), brief=mission,
            status=status, step=step, step_at=step_at, started=started, finished=finished,
            elapsed=max(0, (finished or now) - started) if started else None,
            result=j.get("result") or "",
            detail=j.get("detail") or "",
            quiet=bool(j.get("quiet")),
            diagnostic="diagnostic" in mission.lower(),
            stoppable=True, model=""))
    # Delegated children are not handoff jobs: they live in Hermes's own cache (read-only),
    # so there is no pid to signal and the dashboard cannot stop them. The reader already
    # shapes them like helper jobs, and the one shared namer labels both kinds.
    for d in delegations.snapshot(limit=limit):
        d["name"] = _agent_name(d["brief"])
        out.append(d)
    out.sort(key=lambda a: (a["status"] not in ("running", "stalled"), -(a["started"] or 0)))
    return dict(now=now, agents=out[:limit],
                running=sum(1 for a in out if a["status"] == "running"))


_CMD = re.compile(r"^\s*/(new|profile|goal|personality|kanban|mission|missions|background|tools|toolsets|connectors|connect|status|commands|help|browser|clear)\b\s*(.*)$", re.I | re.S)

_DEPT_CACHE = {"root": None, "at": 0.0, "data": None}
_DEPT_TTL = 30.0

_TIME_QUERIES = {
    "time", "current time", "what time is it", "what is the time", "whats the time",
    "what's the time", "tell me the time", "date", "current date", "what day is it",
    "what is the date", "whats the date", "what's the date", "what is today",
    "whats today", "what's today", "what is todays date", "what's today's date",
}
_STATUS_QUERIES = {
    "status", "system status", "atlas status", "dashboard status", "gateway status",
    "runtime status", "are you online", "are you there", "health", "ping",
}
_JOBS_QUERIES = {
    "jobs", "running jobs", "active jobs", "background jobs", "job status",
    "what jobs are running", "what is running", "whats running", "what's running",
    "agents", "running agents", "active agents", "missions", "running missions",
}
_DEPTS_QUERIES = {
    "departments", "department", "list departments", "show departments",
    "all departments", "our departments", "what departments do we have",
    "which departments do we have",
}
_TEAMS_QUERIES = {
    "teams", "team", "sub-teams", "subteams", "list teams", "show teams",
    "all teams", "our teams", "what teams do we have", "which teams do we have",
}
_CLEAR_QUERIES = {
    "clear", "clear screen", "clear display", "clear chat", "clear panel", "reset display",
}
_HELP_QUERIES = {
    "help", "commands", "list commands", "show commands", "available commands",
    "what commands are available",
}
_WHO_QUERIES = {
    "who are you", "what are you", "what is your name", "whats your name",
    "what's your name", "introduce yourself", "are you atlas",
}
_TODAY_QUERIES = {
    "tasks", "queue", "mission queue", "what is on today", "whats on today",
    "what's on today", "todo", "to do",
}


def _cached_departments():
    now = time.monotonic()
    root_str = str(brain.ROOT)
    if _DEPT_CACHE["data"] is not None and _DEPT_CACHE["root"] == root_str and (now - _DEPT_CACHE["at"]) < _DEPT_TTL:
        return _DEPT_CACHE["data"]
    data = brain.departments()
    _DEPT_CACHE.update(root=root_str, at=now, data=data)
    return data


def _normalize_fast_query(message):
    q = " ".join((message or "").strip().split()).lower()
    if q.startswith("/"):
        q = q[1:].strip()
    q = re.sub(r"^(?:hey\s+atlas|ok\s+atlas|atlas|jarvis)[,:\s]+", "", q).strip()
    q = re.sub(r"^(?:please\s+)", "", q).strip()
    q = q.strip("?!.,;:'\" ")
    return " ".join(q.split())


_STOP_QUERIES = {"stop", "stop talking", "stop it", "be quiet", "quiet", "shush", "hush",
                 "never mind", "nevermind", "cancel", "that's all", "thats all", "enough"}
_REPEAT_QUERIES = {"repeat", "repeat that", "say that again", "say again", "what did you say",
                   "come again", "pardon", "sorry what", "i missed that"}
_SLOWER_QUERIES = {"slower", "speak slower", "talk slower", "slow down", "a bit slower"}
_FASTER_QUERIES = {"faster", "speak faster", "talk faster", "speed up", "a bit faster"}
_FRESH_QUERIES = {"new topic", "start over", "fresh start", "change of subject", "let's start over",
                  "lets start over", "new conversation"}
_TALK_QUERIES = {
    "brief": {"keep it brief", "keep it short", "be brief", "short answers", "short answers please", "talk less",
              "less talking", "be more concise", "keep your answers short", "just the short version from now on"},
    "chatty": {"talk me through things", "be more chatty", "be chattier", "be more talkative", "say more",
               "talk more", "longer answers", "give me longer answers", "give me more detail", "don't be so brief",
               "dont be so brief", "stop being so brief", "talk to me properly", "be less dry"},
    "normal": {"talk normally", "back to normal", "normal answers", "normal length", "answer normally"},
}
_RETIRE_QUERIES = {"don't say that again", "dont say that again", "stop saying that", "never say that again",
                   "retire that line", "retire that", "drop that line", "i don't like that line", "i dont like that line"}
_FRESHEN_QUERIES = {"freshen up your lines", "freshen your lines", "freshen up your phrases", "learn some new lines",
                    "get some new lines", "come up with some new lines", "new phrases please", "you need new lines"}
_NEW_LINES_QUERIES = {"what are the new lines", "read me the new lines", "show me the new lines", "new lines"}
_USAGE_QUERIES = {"which lines do you say most", "what do you say most", "which lines do you overuse",
                  "your most used lines", "what are your most used lines"}
_KEEP_LINES = {"keep them", "keep the new lines", "keep those lines", "keep those", "use them", "use the new lines"}
_BIN_LINES = {"bin them", "bin the new lines", "drop the new lines", "drop them", "scrap them", "scrap the new lines"}

_FRESHEN_PROMPT = """Write new stock spoken lines for Atlas, a voice assistant with an English character: a sharp, unflappable chief of staff with dry humour and understatement. Natural British English, never a caricature. Each line is short (under 12 words), plain speech with no markdown, and must sound different from the ones already in use.

Read the lines in use here (a JSON file of groups; ignore "_readme", "never_say" and "retired"):
{library}

For each of these groups write 4 new lines in the same job as the group's existing lines: {groups}.
Keep any word in curly brackets, such as {{time}} or {{note}}, exactly as the existing lines of that group use it.

Then write a JSON file at exactly this path (create the folder, overwrite the file):
{path}

with exactly this shape, one list per group:
{{"ack": ["...", "..."], "greet_morning": ["..."]}}

Do not edit the library file itself. When finished, say in two sentences how many lines you wrote and give two examples."""


def _voice_control(q):
    """Things you say to Atlas *about the conversation*. Answered at once, no model call."""
    if q in _STOP_QUERIES:
        return dict(message=None, reply="", note="voice: stop", intent="stop", fast_path=True)
    if q in _REPEAT_QUERIES:
        last = next((t.get("assistant") for t in reversed(get_history()) if t.get("assistant")), "")
        return dict(message=None, reply=last or "I haven't said anything yet.",
                    note="voice: repeat", intent="repeat", fast_path=True)
    if q in _SLOWER_QUERIES or q in _FASTER_QUERIES:
        import voice
        step = -0.1 if q in _SLOWER_QUERIES else 0.1
        new = round(min(voice.SPEED_MAX, max(voice.SPEED_MIN, voice.KOKORO_SPEED + step)), 2)
        if new == round(voice.KOKORO_SPEED, 2):
            reply = "That's as slow as I go." if step < 0 else "That's as fast as I go."
        else:
            cleaned, _ = set_settings({"voice_speed": new})
            voice.apply_settings(cleaned or {})
            reply = "Slower it is." if step < 0 else "Faster it is."
        return dict(message=None, reply=reply, note=f"voice speed {voice.KOKORO_SPEED}",
                    intent="speed", fast_path=True)
    if q in _FRESH_QUERIES:
        return dict(fresh=True, message=None, reply=phrases.pick("fresh", "Fresh start."), note="Hermes thread reset",
                    intent="fresh", fast_path=True)
    for mode, said in _TALK_QUERIES.items():
        if q in said:
            set_settings({"talk": mode})
            return dict(message=None, reply=phrases.pick(f"talk_{mode}", "Understood."), note=f"talk: {mode}",
                        intent="talk", fast_path=True)
    return _phrase_control(q)


def _phrase_control(q):
    """The phrase library by voice: retire the stock line just used, ask for new ones, keep or bin them."""
    def out(reply, note):
        return dict(message=None, reply=reply, note=note, intent="phrases", fast_path=True)

    if q in _RETIRE_QUERIES:
        line = phrases.last_spoken
        if phrases.retire(line):
            return out(phrases.say("retired_line", 'You won\'t hear "{line}" again.', line=line.rstrip(".!?")), f"retired: {line[:40]}")
        return out("I haven't used one of my stock lines just now, so there's nothing to retire. "
                   "If it was something I said in an answer, tell me what to avoid and I'll remember it.", "retire: nothing")
    if q in _FRESHEN_QUERIES:
        from tools import handoff
        groups = [g for g in phrases.all_lines() if g != "never_say"]
        jid = handoff.launch(_FRESHEN_PROMPT.format(library=phrases.FILE, path=phrases.CANDIDATES, groups=", ".join(groups)))
        return out("Good idea, I was boring myself. A helper is writing some now; when it's back, say "
                   "\"what are the new lines\" and keep or bin them.", f"helper {jid}: new phrase lines")
    if q in _USAGE_QUERIES:
        top = sorted(phrases.usage().items(), key=lambda kv: -kv[1])[:8]
        if not top:
            return out("I haven't been keeping count for long enough to say. Ask me again in a day or two.", "usage: none")
        return out(f"My most used line is \"{top[0][0].rstrip('.!?')}\", {top[0][1]} times. The top of the list is on screen; "
                   "say \"don't say that again\" right after one you're tired of and I'll retire it.\n\n---\n\n"
                   + "\n".join(f"- {n}× {line}" for line, n in top), f"usage: {len(top)}")
    new = phrases.candidates()
    if q in _NEW_LINES_QUERIES:
        if not new:
            return out("There are no new lines waiting. Say \"freshen up your lines\" and I'll have some written.", "new lines: none")
        n = sum(len(v) for v in new.values())
        sample = [v[0] for v in list(new.values())[:3]]
        listing = "\n".join(f"**{g}**\n" + "\n".join(f"- {s}" for s in v) for g, v in new.items())
        return out(f"{n} new lines across {len(new)} groups. For a taste: " + " ".join(sample)
                   + " The full list is on screen. Say keep them or bin them.\n\n---\n\n" + listing, f"new lines: {n}")
    if new and q in _KEEP_LINES:
        n = phrases.keep_candidates()
        return out(f"Done, {n} new lines are in. You'll start hearing them from now on.", f"kept {n} lines")
    if new and q in _BIN_LINES:
        phrases.drop_candidates()
        return out("Binned, all of them. No hard feelings.", "new lines binned")
    return None


def _status_reply():
    """One spoken line: what's running and how Atlas hears and speaks. Read aloud, so no paths."""
    import runtime
    import voice
    profile = runtime.PROFILE
    running = len(running_jobs())
    speaks = {"kokoro": "Kokoro", "local": "the Mac voice"}.get(voice.tts_engine(), "the browser voice")
    hears = "Parakeet" if voice.stt_engine() == "parakeet" else "browser speech recognition"
    jobs = (f"{running} background job{'s' if running != 1 else ''} running" if running
            else "nothing running in the background")
    warm = ("Hermes is kept warm through its API server" if runtime.api_backend_ready()
            else "Hermes starts fresh for each turn")
    return (f"Online on the {profile} profile. Speaking with {speaks}, listening with {hears}. "
            f"{warm}. {jobs[0].upper() + jobs[1:]}.")


def _fast_jobs_summary():
    running = running_jobs()
    done_count = sum(1 for j in _handoff_jobs() if j.get("status") in ("done", "failed"))
    d = load()
    open_tasks = [t["text"] for t in d.get("tasks", []) if not t.get("done")]
    parts = []
    if running:
        names = [_agent_name(j.get("mission", "")) for j in running[:4]]
        parts.append(f"{len(running)} running job{'s' if len(running) != 1 else ''}: {', '.join(names)}.")
    else:
        parts.append(phrases.pick("nothing_running", "Nothing is running in the background."))
    if done_count:
        parts.append(f"{done_count} completed job{'s' if done_count != 1 else ''} on record.")
    if open_tasks:
        parts.append(f"Mission queue ({len(open_tasks)}): " + "; ".join(open_tasks[:5]) + ".")
    return " ".join(parts)


def _fast_departments_summary():
    depts = _cached_departments().get("departments", [])
    if not depts:
        return "No departments found in the Atlas brain folder."
    items = [f"{d['name']} ({len(d.get('teams', []))} teams)" for d in depts]
    return f"{len(depts)} departments: " + ", ".join(items) + "."


def _fast_teams_summary():
    depts = _cached_departments().get("departments", [])
    if not depts:
        return "No teams found in the Atlas brain folder."
    teams = []
    for d in depts:
        for t in d.get("teams", []):
            teams.append(f"{t['name']} ({d['name']})")
    if not teams:
        return "No sub-teams found under departments."
    return f"{len(teams)} teams across {len(depts)} departments: " + ", ".join(teams) + "."


_BRAIN = r"(?:the\s+|my\s+)?(?:second\s+)?brain"
_BRAIN_CLOSE = re.compile(rf"^(?:close|hide|exit|leave)\s+{_BRAIN}$")
_BRAIN_OPEN = re.compile(rf"^(?:open|show(?:\s+me)?|go\s+to|pull\s+up|bring\s+up)\s+{_BRAIN}$")
_BRAIN_NEW = re.compile(rf"^(?:what(?:'?s|\s+is)\s+new|what\s+changed)(?:\s+this\s+week)?\s+in\s+{_BRAIN}(?:\s+this\s+week)?$"
                        rf"|^(?:show|open|play)(?:\s+me)?\s+(?:the\s+|my\s+)?(?:brain\s+)?timeline$")
_BRAIN_ISOLATE = re.compile(rf"^(?:isolate\s+(.+?)(?:\s+in\s+{_BRAIN})?|(?:focus|zoom)\s+(?:in\s+)?on\s+(.+?)\s+in\s+{_BRAIN})$")
_BRAIN_FIND = re.compile(rf"^(?:show(?:\s+me)?|open|find|pull\s+up|bring\s+up|go\s+to|take\s+me\s+to|jump\s+to)\s+(.+?)\s+(?:in|from|on)\s+{_BRAIN}$")
_BRAIN_SEARCH = re.compile(rf"^(?:search|look)\s+(?:in\s+|through\s+)?{_BRAIN}\s+for\s+(.+)$"
                           rf"|^(?:search|look)\s+for\s+(.+?)\s+in\s+{_BRAIN}$"
                           rf"|^what\s+(?:do|does)\s+my\s+(?:notes|brain)\s+say\s+about\s+(.+)$"
                           rf"|^which\s+(?:of\s+my\s+)?notes\s+(?:mention|talk\s+about)\s+(.+)$")
_BRAIN_HEALTH = re.compile(rf"^(?:check|tidy|audit)\s+{_BRAIN}$|^how\s+(?:healthy\s+is|is)\s+{_BRAIN}(?:\s+doing)?$"
                           rf"|^brain\s+(?:health|check)$")
# looser phrasings only claim the turn on a clear name match, so "brain dump my day" still reaches Hermes
_LOOSE_FIND = re.compile(r"^(?:show(?:\s+me)?|open|pull\s+up|bring\s+up)\s+(.+?\s+notes?)$|^brain[\s,:]+(.+)$")


def _brain_intent(q):
    """Voice control for the Brain graph. Returns a fast-path reply with a `ui` action, or None.
    "show me X notes" only claims the turn when X really is a note; anything else goes to Hermes."""
    def ui(action, reply, **kw):
        return dict(message=None, reply=reply, note=f"fast-path: brain {action}", intent="brain",
                    fast_path=True, ui=dict(view="brain", action=action, **kw))

    def pretty(name):
        return name.replace("-", " ")

    if _BRAIN_CLOSE.match(q):
        return ui("close", "Closing the brain.")
    if _BRAIN_OPEN.match(q):
        return ui("open", "Here's your brain.")
    if _BRAIN_NEW.match(q):
        return ui("timeline", "Here's what's new in your brain this week.", days=7)
    if _BRAIN_HEALTH.match(q):
        h = brain.health()
        parts = [f"{len(h[k])} {word}{'' if len(h[k]) == 1 else 's'}"
                 for k, word in (("broken", "broken link"), ("orphans", "unlinked note"), ("duplicates", "hidden duplicate"))
                 if h[k]]
        return ui("health", (f"{h['notes']} notes. To tidy: " + ", ".join(parts) + "." if parts
                             else f"{h['notes']} notes, all linked up. Nothing to tidy."))

    def in_text(what):
        """Notes that mention `what` anywhere: the list goes on screen, the count is spoken."""
        res = brain.search(what, limit=3)
        if not res["count"]:
            return ui("find", f"Nothing in your brain mentions {what}.", q=what)
        top = pretty(res["results"][0]["id"])
        n = res["count"]
        return ui("find", (f"One note mentions {what}: {top}." if n == 1
                           else f"{n} notes mention {what}. The closest is {top}."), q=what, id=res["results"][0]["id"])
    m = _BRAIN_SEARCH.match(q)
    if m:
        return in_text(next(g for g in m.groups() if g))
    m = _BRAIN_ISOLATE.match(q)
    if m:
        what = m.group(1) or m.group(2)
        name = brain.find_note(what)
        if name:
            return ui("isolate", f"Isolating {pretty(name)} and its neighbours.", id=name)
        return ui("search", f"I couldn't find a note matching {what}.", q=what)
    m = _BRAIN_FIND.match(q)
    if m:
        name = brain.find_note(m.group(1))
        if name:
            return ui("open", f"Here's {pretty(name)}.", id=name)
        return in_text(m.group(1))                  # no note by that name: look inside the notes
    m = _LOOSE_FIND.match(q)
    if m:
        name = brain.find_note(m.group(1) or m.group(2), min_tier=2)
        if name:
            return ui("open", f"Here's {pretty(name)}.", id=name)
    return None


# ── quick capture: "note that …", "add … to my pricing notes" — saved at once, no model call ──
_SAY = r"^\s*(?:(?:hey\s+atlas|ok\s+atlas|atlas|jarvis)[,:\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?"
_NOTE_THAT = re.compile(_SAY + r"(?:(?:make|take|add|write|jot)\s+(?:down\s+)?(?:a\s+)?(?:quick\s+)?note|note\s+down|jot\s+down|note)"
                        r"\s*(?:that\b|:|,)\s*(.+?)\s*$", re.I | re.S)
_NOTE_SELF = re.compile(_SAY + r"note\s+to\s+(?:my)?self[\s,:]+(.+?)\s*$", re.I | re.S)
_NOTE_ADD = re.compile(_SAY + r"(?:add|append|put|write)\s+(.+?)\s+(?:to|in|into|on)\s+(?:my\s+|the\s+)?(.+?)\s+notes?[.!]?\s*$", re.I | re.S)
_NOTE_ADD_TO = re.compile(_SAY + r"(?:add|append)\s+to\s+(?:my\s+|the\s+)?(.+?)\s+notes?\s*(?:that\b|:|,)\s*(.+?)\s*$", re.I | re.S)


def _capture_intent(message):
    """Things you ask Atlas to write down. The words are saved exactly as said. Returns a
    fast-path reply, or None so the request goes to Hermes (no brain folder, no such note)."""
    def out(reply, name):
        return dict(message=None, reply=reply, note=f"brain: wrote {name}", intent="capture", fast_path=True,
                    ui=dict(view="brain", action="wrote", id=name))

    raw = message or ""
    m = _NOTE_ADD_TO.match(raw)
    target, text = (m.group(1), m.group(2)) if m else (None, None)
    if not m:
        m = _NOTE_ADD.match(raw)
        if m:
            text, target = m.group(1), m.group(2)
    if target:
        name = brain.find_note(target, min_tier=2)
        if not name:
            return None                              # not a note we know: Hermes decides what was meant
        text = text.strip().rstrip(".")
        _, err = brain.append_line(name, f"- {text[:1].upper() + text[1:]} ({datetime.date.today().isoformat()})")
        return None if err else out(phrases.say("added", "Added to {note}.", note=name.replace("-", " ")), name)
    m = _NOTE_SELF.match(raw) or _NOTE_THAT.match(raw)
    if m and len(m.group(1).split()) >= 2:
        saved, err = brain.capture(m.group(1))
        return None if err else out(phrases.pick("noted", "Noted."), saved["id"])
    return None


# ── voice control for helper jobs ("stop the flight job", "what did the brief helper find") ──
_JOB = r"(?:background\s+)?(?:job|helper|agent|mission|task)"
_JOB_STOP_ALL = re.compile(rf"^(?:stop|cancel|kill|end|abort)\s+(?:all|every|everything)(?:\s+(?:the\s+)?(?:running\s+)?{_JOB}s?)?(?:\s+running)?$")
_JOB_STOP = re.compile(rf"^(?:stop|cancel|kill|end|abort)\s+(?:the\s+|that\s+|this\s+|my\s+)?(.*?)\s*{_JOB}$")
_JOB_ASK = re.compile(rf"^(?:what\s+(?:did|has)\s+(?:the\s+|that\s+|my\s+)?(.*?)\s*{_JOB}\s+(?:find|found|say|said|report|get|come\s+back\s+with)"
                      rf"|how(?:'?s|\s+is)\s+(?:the\s+|that\s+|my\s+)?(.*?)\s*{_JOB}(?:\s+(?:going|doing))?"
                      rf"|(?:status|result)\s+of\s+(?:the\s+|that\s+|my\s+)?(.*?)\s*{_JOB})$")
_JOB_START = re.compile(rf"^\s*(?:please\s+)?(?:start|launch|kick\s+off|spin\s+up)\s+(?:a\s+|an\s+)?{_JOB}\s+(?:to|that|for)\s+(.+)$", re.I | re.S)
_JOB_FILLER = {"the", "a", "an", "my", "that", "this", "one", "background", "running", "last", "latest"}


def _stem(w):
    return w[:5]


def find_job(query, running_only=False):
    """The helper job a spoken phrase means: best word overlap with its brief, newest first.
    A vague phrase ("the job") means the only running one, if there is exactly one."""
    words = {_stem(w) for w in re.sub(r"[^a-z0-9 ]+", " ", query.lower()).split() if w not in _JOB_FILLER}
    jobs = sorted(_handoff_jobs(), key=lambda j: -(j.get("started") or 0))
    if running_only:
        jobs = [j for j in jobs if job_is_live(j)]
    if not words:
        running = [j for j in jobs if job_is_live(j)]
        if len(running) == 1:
            return running[0]
        if not running and not running_only and jobs:
            return jobs[0]                          # "what did the job find" = the latest one
        return None                                 # several running: too vague to pick
    best, best_score = None, 0
    for j in jobs:
        text = re.sub(r"[^a-z0-9 ]+", " ", str(j.get("mission") or "").lower())
        score = len(words & {_stem(w) for w in text.split()})
        if score > best_score:
            best, best_score = j, score
    return best


def _job_reply(j):
    name = _agent_name(j.get("mission", ""))
    status = j.get("status")
    if status == "running" and not job_is_live(j):
        return f"{name} stopped unexpectedly."
    if status == "running":
        mins = int(max(0, time.time() - (j.get("started") or time.time())) // 60)
        _, step = _last_log_line(j.get("id") or "")
        when = f"{mins} minute{'s' if mins != 1 else ''} in" if mins else "just started"
        return f"{name} is still working, {when}." + (f" Last step: {step[:120]}." if step else "")
    if status == "failed":
        return f"{name} failed: {str(j.get('result') or 'no reason given')[:240]}"
    if status == "stopped":
        return f"{name} was stopped."
    return f"{name}: {str(j.get('result') or 'Finished with nothing to report.')[:900]}"


def _jobs_intent(q, message):
    def out(reply, intent, note):
        return dict(message=None, reply=reply, note=note, intent=intent, fast_path=True)

    raw = re.sub(r"^\s*(?:hey\s+atlas|ok\s+atlas|atlas|jarvis)[,:\s]+", "", message or "", flags=re.I)
    m = _JOB_START.match(raw)
    if m and len(m.group(1).split()) >= 2:
        from tools import handoff
        mission = " ".join(m.group(1).split())
        jid = handoff.launch(mission[:1].upper() + mission[1:])
        import phrases
        return out(phrases.pick("handoff", "On it. I've handed that to a helper and I'll tell you when it lands."),
                   "job_start",
                   f"helper {jid} started: {mission[:50]}")
    if _JOB_STOP_ALL.match(q):
        running = running_jobs()
        for j in running:
            stop_job(j.get("id"))
        n = len(running)
        return out(f"Stopping {n} helper{'s' if n != 1 else ''}." if n else "Nothing is running.",
                   "job_stop", f"stop all: {n}")
    m = _JOB_STOP.match(q)
    if m:
        j = find_job(m.group(1), running_only=True)
        if not j:
            return out("I couldn't tell which running job you mean. Say it with a word from its brief.",
                       "job_stop", "stop: no match")
        _, err = stop_job(j.get("id"))
        name = _agent_name(j.get("mission", ""))
        return out(f"Stopping {name}." if not err else f"I couldn't stop {name}: {err}.", "job_stop",
                   f"stop {j.get('id')}")
    m = _JOB_ASK.match(q)
    if m:
        j = find_job(m.group(1) or m.group(2) or m.group(3) or "")
        if not j:
            return out("I couldn't find a job like that.", "job_status", "job: no match")
        return out(_job_reply(j), "job_status", f"job {j.get('id')}")
    return None


def _ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def fast_path(message):
    """Local intent router for simple queries (<50ms, zero model/subprocess calls).

    Returns a command response dict with `message=None` when matched, or `None`
    when the query should be sent to Hermes.
    """
    q = _normalize_fast_query(message)
    if not q:
        return None

    if q in _TIME_QUERIES:
        now = datetime.datetime.now()
        reply = phrases.say("time", "It's {time} on {day}.", time=now.strftime("%H:%M"),
                            day=now.strftime("%A the ") + _ordinal(now.day) + now.strftime(" of %B"))
        return dict(message=None, reply=reply, note="fast-path: time", intent="time", fast_path=True)

    if q in _STATUS_QUERIES:
        return dict(message=None, reply=_status_reply(), note="status read", intent="status", fast_path=True)

    if q in _JOBS_QUERIES:
        return dict(message=None, reply=_fast_jobs_summary(), note="fast-path: jobs", intent="jobs", fast_path=True)

    if q in _DEPTS_QUERIES:
        return dict(message=None, reply=_fast_departments_summary(), note="fast-path: departments",
                    intent="departments", fast_path=True)

    if q in _TEAMS_QUERIES:
        return dict(message=None, reply=_fast_teams_summary(), note="fast-path: teams",
                    intent="teams", fast_path=True)

    if q in _CLEAR_QUERIES:
        return dict(message=None, reply=phrases.pick("cleared", "Screen's clear. The conversation is untouched."),
                    note="display clear", intent="clear", fast_path=True)

    if q in _HELP_QUERIES:
        return dict(message=None, reply=_commands_reply(), note="commands shown",
                    intent="help", fast_path=True)

    if q in _WHO_QUERIES:
        name = str(get_settings().get("user_name") or "").strip()
        whose = f"{name}'s" if name else "your"
        reply = phrases.say("who", "I'm Atlas, {whose} chief of staff.", whose=whose)
        return dict(message=None, reply=reply, note="fast-path: identity",
                    intent="who_are_you", fast_path=True)

    hit = _voice_control(q)
    if hit:
        return hit

    hit = _jobs_intent(q, message)
    if hit:
        return hit

    hit = _capture_intent(message)
    if hit:
        return hit

    hit = _brain_intent(q)
    if hit:
        return hit

    if q in _TODAY_QUERIES:
        d = load()
        open_t = [t["text"] for t in d.get("tasks", []) if not t.get("done")]
        goal = d.get("goal") or "No standing objective set."
        q_part = ("Mission queue: " + "; ".join(open_t) + ".") if open_t else "Mission queue is empty."
        return dict(message=None, reply=f"Standing objective: {goal} {q_part}",
                    note="fast-path: today", intent="today", fast_path=True)

    return None


def _shell(cmd, timeout=25):
    import runtime
    try:
        p = subprocess.run(cmd, text=True, cwd=runtime.WORKDIR, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout)
        return (p.stdout or p.stderr or "").strip()[:3500]
    except Exception as e:  # noqa: BLE001
        return f"Unavailable: {e}"


def _commands_reply():
    return """Available dashboard slash commands:
/new — reset the Hermes thread
/goal <text|status|clear> — set/read/clear standing objective
/profile <fact> — add a local profile note injected into Hermes prompts
/profile forget <words> — remove the profile notes containing those words
/personality <tone> — set Atlas tone overlay
/kanban [task] — read/add mission queue item
/mission done <words> — take the missions containing those words off the queue
/mission [task] — alias for /kanban
/background <mission> — run a Hermes mission asynchronously
/tools — show Hermes tool status from `hermes tools list`
/connectors — explain that connected Hermes tools transfer into this dashboard
/connect <name> — ask Hermes how to connect a third-party app generally
/toolsets — ask Hermes to list available toolsets
/status — local Hermes runtime/profile/status
/browser <task> — ask Hermes to use browser/Chrome tools
/clear — clear the response panel locally
/help or /commands — show this list

You can also type normal Hermes prompts. Unknown slash commands are forwarded to Hermes."""


def _drop_matching(key, needle, text_of):
    """Remove the entries of state[key] whose text contains `needle`; returns their texts.
    Missions and profile notes ride in every prompt, and there was no way to take one out."""
    needle = " ".join(needle.lower().split())
    gone = []

    def drop(state):
        keep = []
        for item in state.get(key, []):
            text = str(text_of(item))
            (gone if needle and needle in " ".join(text.lower().split()) else keep).append(item)
        state[key] = keep
    update_state(drop)
    return [str(text_of(x)) for x in gone]


def handle(message):
    m = _CMD.match(message or "")
    if not m:
        return fast_path(message)
    cmd, arg = m.group(1).lower(), m.group(2).strip()
    d = load()

    if cmd in ("help", "commands"):
        return dict(message=None, reply=_commands_reply(), note="commands shown")

    if cmd == "clear":
        return dict(message=None, reply=phrases.pick("cleared", "Screen's clear. The conversation is untouched."), note="display clear")

    if cmd == "new":
        return dict(fresh=True, message=arg or "Start a fresh Hermes dashboard session. Greet me in one concise ATLAS-style line.", note="Hermes thread reset")

    if cmd == "status":
        return dict(message=None, reply=_status_reply(), note="status read")

    if cmd in ("tools", "toolsets"):
        if cmd == "tools":
            import runtime
            out = _shell(runtime._hermes_base() + ["tools", "list"])
            reply = out or "No tool list returned. Start from a shell where `hermes tools list` works, or set HERMES_CMD."
            return dict(message=None, reply=reply, note="Hermes tools listed")
        return dict(message="List my enabled Hermes toolsets and connected third-party tools. Include browser/Chrome availability if present. Keep it concise.", note="toolsets requested")

    if cmd == "connectors":
        return dict(message=None, note="connector bridge explained", reply=(
            "This dashboard does not need separate app wiring. It launches Hermes with your active profile, so any third-party app already connected in Hermes transfers here automatically.\n\n"
            "Connect apps in Hermes itself with: hermes tools, hermes mcp, hermes gateway setup, or the relevant Hermes skill. Then restart this dashboard.\n\n"
            "Use /tools or /toolsets here to see what the dashboard can currently reach."
        ))

    if cmd == "connect":
        target = (arg or "third-party app").strip()
        return dict(message=(
            f"Explain the correct Hermes-native way to connect {target} as a third-party app/tool. "
            "Be generic: the dashboard should inherit whatever is connected to Hermes, not maintain separate credentials. "
            "Include the relevant Hermes command family if known, like hermes tools, hermes mcp, hermes gateway setup, or a skill."
        ), note=f"connector help: {target[:40]}")

    if cmd == "browser":
        task = arg or "open or inspect Google Chrome using the configured Hermes browser/computer-use tools and report what is available"
        return dict(message=f"Use my Hermes browser/Google Chrome tooling if available: {task}", note="browser mission armed")

    if cmd == "profile":
        if not arg:
            facts = d["profile"]
            return dict(message=None, reply=("\n".join(f"- {x}" for x in facts[-20:]) if facts else "I don't know anything about you yet."), note="profile read")
        forget = re.match(r"(?:forget|remove)\s+(.+)$", arg, re.I | re.S)
        if forget:
            gone = _drop_matching("profile", forget.group(1), lambda x: x)
            return dict(message=None, note=f"profile -= {len(gone)}",
                        reply=("Forgotten: " + "; ".join(gone) + "." if gone
                               else f"No profile note matches \"{forget.group(1).strip()}\"."))
        update_state(lambda state: state["profile"].append(arg))
        return dict(message=f'The user saved this dashboard profile note: "{arg}". Acknowledge in one short line.', note=f"profile += {arg[:50]}")

    if cmd == "goal":
        if arg.lower() == "clear":
            update_state(lambda state: state.__setitem__("goal", ""))
            return dict(message=None, reply="Standing objective cleared.", note="goal cleared")
        if not arg or arg.lower() == "status":
            return dict(message=None, reply=d["goal"] or "No standing objective set.", note="goal read")
        update_state(lambda state: state.__setitem__("goal", arg))
        return dict(message=f'The user set this standing objective: "{arg}". Acknowledge in one concise line.', note=f"goal set: {arg[:50]}")

    if cmd == "personality":
        if not arg:
            return dict(message=None, reply=d["personality"] or "Running default ATLAS persona.", note="persona read")
        update_state(lambda state: state.__setitem__("personality", arg))
        return dict(message=f'Tone overlay changed to: "{arg}". Reply briefly in that tone so he can hear it.', note=f"persona: {arg[:50]}")

    if cmd in ("kanban", "mission", "missions"):
        done = re.match(r"(?:done|finished|complete|remove)\s+(.+)$", arg, re.I | re.S)
        if done:
            gone = _drop_matching("tasks", done.group(1), lambda t: t.get("text", ""))
            return dict(message=None, note=f"mission -= {len(gone)}",
                        reply=("Off the queue: " + "; ".join(gone) + "." if gone
                               else f"No mission matches \"{done.group(1).strip()}\"."))
        if arg:
            update_state(lambda state: state["tasks"].append(
                {"text": arg, "done": False, "at": time.time()}))
            return dict(message=f'Added to the mission queue: "{arg}". Confirm in one short line.', note=f"mission += {arg[:50]}")
        open_t = [t["text"] for t in d["tasks"] if not t.get("done")]
        if not open_t:
            return dict(message=None, reply="Mission queue is empty.", note="queue read")
        return dict(message=None, reply="Mission queue:\n" + "\n".join(f"- {t}" for t in open_t), note=f"queue read ({len(open_t)})")

    if cmd == "background":
        if not arg:
            return dict(message=None, reply="Give me a mission.", note="background empty")
        from tools import handoff
        jid = handoff.launch(arg)
        return dict(message=None, reply=phrases.pick("handoff", "That's with a helper now. I'll tell you when it lands."),
                    note=f"mission {jid} started: {arg[:50]}")

    return None
