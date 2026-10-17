"""
Command matrix for the Hermes-backed JARVIS dashboard.

Local commands keep the HUD fast for mission control/status while prompts and
unknown slash commands are handed to Hermes Agent. Hermes-native tool access comes
from the runtime subprocess (`hermes chat -q ...`) using the configured profile.
"""
import datetime
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import threading
import time
import uuid

import brain

ROOT = pathlib.Path(__file__).resolve().parent
STATE_FILE = pathlib.Path(os.environ.get("JARVIS_STATE", ROOT / "state.json"))
_LOCK = threading.Lock()
_DEFAULT = {"profile": [], "goal": "", "personality": "", "tasks": [], "missions": [], "session": None, "history": [], "settings": {}}


def _load_unlocked():
    try:
        d = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return {**_DEFAULT, **d}
    except (OSError, json.JSONDecodeError):
        return dict(_DEFAULT)


def load():
    with _LOCK:
        return _load_unlocked()


def _save_unlocked(d):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_name(f".{STATE_FILE.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, STATE_FILE)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def save(d):
    with _LOCK:
        _save_unlocked(d)


def update_state(mutator):
    """Apply one read-modify-write transaction without losing concurrent updates."""
    with _LOCK:
        d = _load_unlocked()
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
    if "greeting" in updates:
        cleaned["greeting"] = bool(updates["greeting"])
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
        out.append(f"## Tone overlay\n{d['personality']}\nThis adjusts delivery; stay concise.")
    open_tasks = [t for t in d["tasks"] if not t.get("done")]
    if open_tasks:
        out.append("## Mission queue\n" + "\n".join(f"- {t['text']}" for t in open_tasks[:20]))
    return "\n\n".join(out)


JOBS = {}
_JOB_LOCK = threading.Lock()


def start_background(mission, runner):
    jid = uuid.uuid4().hex[:8]
    with _JOB_LOCK:
        JOBS[jid] = {"id": jid, "status": "running", "mission": mission,
                     "result": "", "started": time.time(), "finished": None}
    update_state(lambda d: d["missions"].append(
        {"id": jid, "mission": mission, "status": "running", "at": time.time()}))

    def _work():
        text = ""
        status = "done"
        try:
            for ev in runner(mission):
                if ev.get("t") == "delta":
                    text += ev["text"]
                elif ev.get("t") == "error":
                    status = "failed"
                    text = text or ("failed: " + str(ev.get("message", ""))[:260])
        except Exception as e:  # noqa: BLE001
            status = "failed"
            text = f"failed: {e}"[:260]
        with _JOB_LOCK:
            JOBS[jid].update(status="done", result=text.strip(), finished=time.time())
        def finish(d2):
            for item in d2.get("missions", []):
                if item.get("id") == jid:
                    item.update(status=status, finished=time.time(), result=text.strip()[:500])
        update_state(finish)

    threading.Thread(target=_work, daemon=True).start()
    return jid


HANDOFF_DIR = ROOT / "logs" / "handoff"


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
    with _JOB_LOCK:
        mem = [dict(j) for j in JOBS.values()]
    files = [{k: v for k, v in j.items() if k != "_path"}
             for j in _handoff_jobs() if j.get("status") == "running"]
    return mem + files


def running_background():
    with _JOB_LOCK:
        return any(j["status"] == "running" for j in JOBS.values())


def take_finished():
    with _JOB_LOCK:
        done = [dict(j) for j in JOBS.values() if j["status"] == "done"]
        for j in done:
            JOBS.pop(j["id"], None)
    for j in _handoff_jobs():
        if j.get("status") in ("done", "failed") and not j.get("reported"):
            path = j.pop("_path")
            j["reported"] = True
            try:
                pathlib.Path(path).write_text(json.dumps(j), encoding="utf-8")
            except OSError:
                continue
            done.append(j)
    return done


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
    that started before pids were recorded in the job file)."""
    found = {}
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True,
                             text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return found
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
    """Running and recent handoff jobs (+ in-memory /background missions),
    running first then newest first. Never mutates job files."""
    now = time.time()
    jobs = []
    for j in _handoff_jobs():
        j.pop("_path", None)
        j["kind"] = "handoff"
        jobs.append(j)
    with _JOB_LOCK:
        for j in JOBS.values():
            jobs.append(dict(j, kind="background"))
    pids = _worker_pids() if any(j.get("status") == "running" for j in jobs) else {}
    out = []
    for j in jobs:
        jid = j.get("id") or ""
        status = j.get("status") or "unknown"
        started, finished = j.get("started"), j.get("finished")
        step, step_at = "", None
        if j["kind"] == "handoff":
            step_at, step = _last_log_line(jid)
            if status == "running":
                pid = pids.get(jid) or j.get("pid")
                if not (pid and _pid_alive(pid)):
                    status = "stalled"
                    step = step or "worker process is no longer running"
                elif not step:
                    step = "working… (no live output captured for this job)"
        elif status == "running":
            step = "working inside the dashboard server"
        mission = j.get("mission") or ""
        out.append(dict(
            id=jid, kind=j["kind"], name=_agent_name(mission), brief=mission,
            status=status, step=step, step_at=step_at, started=started, finished=finished,
            elapsed=max(0, (finished or now) - started) if started else None,
            result=j.get("result") or "",
            diagnostic="diagnostic" in mission.lower()))
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


def _fast_jobs_summary():
    with _JOB_LOCK:
        mem = [dict(j) for j in JOBS.values()]
    handoff = _handoff_jobs()
    running = [j for j in mem if j.get("status") == "running"]
    done_count = sum(1 for j in mem if j.get("status") in ("done", "failed"))
    for j in handoff:
        st = j.get("status")
        if st == "running":
            pid = j.get("pid")
            if pid is None or _pid_alive(pid):
                running.append(j)
        elif st in ("done", "failed"):
            done_count += 1
    d = load()
    open_tasks = [t["text"] for t in d.get("tasks", []) if not t.get("done")]
    parts = []
    if running:
        names = [_agent_name(j.get("mission", "")) for j in running[:4]]
        parts.append(f"{len(running)} running job{'s' if len(running) != 1 else ''}: {', '.join(names)}.")
    else:
        parts.append("No background jobs are currently running.")
    if done_count:
        parts.append(f"{done_count} completed job{'s' if done_count != 1 else ''} on record.")
    if open_tasks:
        parts.append(f"Mission queue ({len(open_tasks)}): " + "; ".join(open_tasks[:5]) + ".")
    else:
        parts.append("Mission queue is empty.")
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
        reply = f"It is {now.strftime('%H:%M')} on {now.strftime('%A, %d %B %Y')}."
        return dict(message=None, reply=reply, note="fast-path: time", intent="time", fast_path=True)

    if q in _STATUS_QUERIES:
        profile = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default"))
        runtime_cmd = os.environ.get("HERMES_CMD", "hermes")
        with _JOB_LOCK:
            running_mem = sum(1 for j in JOBS.values() if j.get("status") == "running")
        reply = (f"Hermes dashboard online. profile={profile}; runtime={runtime_cmd}; "
                 f"workdir={os.getcwd()}; running_jobs={running_mem}; "
                 "voice=browser Web Speech + optional ElevenLabs.")
        return dict(message=None, reply=reply, note="status read", intent="status", fast_path=True)

    if q in _JOBS_QUERIES:
        return dict(message=None, reply=_fast_jobs_summary(), note="fast-path: jobs", intent="jobs", fast_path=True)

    if q in _DEPTS_QUERIES:
        return dict(message=None, reply=_fast_departments_summary(), note="fast-path: departments",
                    intent="departments", fast_path=True)

    if q in _TEAMS_QUERIES:
        return dict(message=None, reply=_fast_teams_summary(), note="fast-path: teams",
                    intent="teams", fast_path=True)

    if q in _CLEAR_QUERIES:
        return dict(message=None, reply="Display cleared. Hermes session is unchanged.",
                    note="display clear", intent="clear", fast_path=True)

    if q in _HELP_QUERIES:
        return dict(message=None, reply=_commands_reply(), note="commands shown",
                    intent="help", fast_path=True)

    if q in _WHO_QUERIES:
        reply = ("I am Atlas, Mr Thompson's chief-of-staff dashboard powered by Hermes Agent. "
                 "I track operations, coordinate departments, and prepare actions for your approval.")
        return dict(message=None, reply=reply, note="fast-path: identity",
                    intent="who_are_you", fast_path=True)

    if q in _TODAY_QUERIES:
        d = load()
        open_t = [t["text"] for t in d.get("tasks", []) if not t.get("done")]
        goal = d.get("goal") or "No standing objective set."
        q_part = ("Mission queue: " + "; ".join(open_t) + ".") if open_t else "Mission queue is empty."
        return dict(message=None, reply=f"Standing objective: {goal} {q_part}",
                    note="fast-path: today", intent="today", fast_path=True)

    return None


route_intent = fast_path


def _hermes_command(*args):
    configured = os.environ.get("HERMES_CMD", "").strip()
    if configured:
        return shlex.split(configured) + list(args)
    executable = shutil.which("hermes")
    if executable:
        return [executable, *args]
    return ["python3", "-m", "hermes_cli.main", *args]


def _shell(cmd, timeout=25):
    try:
        p = subprocess.run(cmd, text=True, cwd=os.getcwd(), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout)
        return (p.stdout or p.stderr or "").strip()[:3500]
    except Exception as e:  # noqa: BLE001
        return f"Unavailable: {e}"


def _commands_reply():
    return """Available dashboard slash commands:
/new — reset the Hermes thread
/goal <text|status|clear> — set/read/clear standing objective
/profile <fact> — add a local profile note injected into Hermes prompts
/personality <tone> — set Atlas tone overlay
/kanban [task] — read/add mission queue item
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


def handle(message, runner=None):
    m = _CMD.match(message or "")
    if not m:
        return fast_path(message)
    cmd, arg = m.group(1).lower(), m.group(2).strip()
    d = load()

    if cmd in ("help", "commands"):
        return dict(message=None, reply=_commands_reply(), note="commands shown")

    if cmd == "clear":
        return dict(message=None, reply="Display cleared. Hermes session is unchanged.", note="display clear")

    if cmd == "new":
        return dict(fresh=True, message=arg or "Start a fresh Hermes dashboard session. Greet me in one concise ATLAS-style line.", note="Hermes thread reset")

    if cmd == "status":
        profile = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default"))
        runtime = os.environ.get("HERMES_CMD", "hermes")
        return dict(message=None, reply=f"Hermes dashboard online. profile={profile}; runtime={runtime}; workdir={os.getcwd()}; voice=browser Web Speech + optional ElevenLabs.", note="status read")

    if cmd in ("tools", "toolsets"):
        if cmd == "tools":
            out = _shell(_hermes_command("tools", "list"))
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
        return dict(message=f'Tone overlay changed to: "{arg}". Reply in one short line using that tone.', note=f"persona: {arg[:50]}")

    if cmd in ("kanban", "mission", "missions"):
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
        if runner is None:
            return dict(message=None, reply="Background missions aren't available.", note="background unavailable")
        jid = start_background(arg, runner)
        return dict(message=None, reply=f"Background Hermes mission {jid} launched. I'll report when it lands.", note=f"mission {jid} started: {arg[:50]}")

    return None


def _reconcile_orphaned_missions():
    """Missions marked 'running' in state.json were running in a now-dead process
    (the JOBS registry is in-memory). On boot, mark them failed so they don't
    linger as 'running' forever."""
    d = _load_unlocked()
    changed = False
    for m in d.get("missions", []):
        if m.get("status") == "running":
            m["status"] = "failed"
            m["finished"] = m.get("at", time.time())
            m["result"] = m.get("result") or "interrupted by dashboard restart"
            changed = True
    if changed:
        _save_unlocked(d)


_reconcile_orphaned_missions()
