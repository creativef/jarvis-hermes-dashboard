"""Delegated subagents — the platform's own `delegate_task` children.

Hermes writes, per delegation batch (under the active profile's home):

    cache/delegation/live/<delegation_id>/manifest.json
    cache/delegation/live/<delegation_id>/task-<n>.log

``manifest.json`` carries the batch (``delegation_id``, ``started``, ``model``, and a
``tasks`` list of ``{index, goal, log, status}``). It is written at dispatch and
rewritten when the batch aggregates, which stamps ``completed`` and each task's final
``status`` / ``exit_reason``.

Nothing stamps ``completed`` if the parent session dies mid-flight, so liveness comes
from the newest transcript line's age — the same idea as the helper jobs' worker pid,
where the file's own claim is not trusted. Children record every tool call, so silence
is meaningful; the window is generous so a slow build is not called dead.

Read-only by design: the dashboard does not own these children (they belong to an agent
session, not to a dashboard-launched worker) and cannot stop them, so entries are marked
``stoppable=False`` and carry no pid.
"""
import json
import pathlib
import time

_STEP_MAX = 160
_STEP_TAIL_BYTES = 4096
_STALE_AFTER_S = 20 * 60
_TIME_FMT = "%Y-%m-%d %H:%M:%S"

# The words a child's terminal status can arrive as. Anything terminal that we do not
# recognise still counts as failed: never claim a child is running when it said otherwise.
_DONE = {"completed", "done", "success", "succeeded", "ok"}
_GONE = {"failed", "failure", "error", "timeout", "timed_out", "interrupted",
         "cancelled", "canceled", "stopped", "refused", "aborted"}


def live_root(profile_home=None):
    """The live-transcript root for the active profile (``~/.hermes/cache/delegation/live``)."""
    if profile_home is None:
        import runtime                                   # local: keep the module importable alone
        profile_home = runtime._profile_home()
    return pathlib.Path(profile_home) / "cache" / "delegation" / "live"


def _epoch(stamp):
    """A manifest timestamp as epoch seconds; None when absent or unparseable."""
    if not stamp:
        return None
    try:
        return time.mktime(time.strptime(str(stamp).strip(), _TIME_FMT))
    except (ValueError, OverflowError, TypeError):
        return None


def _shorten(line):
    """``20:27:09 tool     | -> terminal(…)`` -> ``tool · -> terminal(…)``."""
    text = " ".join(str(line or "").split())
    head, sep, rest = text.partition(" ")
    if sep and len(head) == 8 and head.count(":") == 2:      # a leading HH:MM:SS stamp
        text = rest.strip()
    kind, sep, detail = text.partition("|")
    if sep:
        text = " ".join((kind.strip() + " · " + detail.strip()).split())
    return text[:_STEP_MAX]


def _last_step(log_path):
    """``(mtime, text)`` of the newest transcript line; ``(None, "")`` when unreadable."""
    path = pathlib.Path(str(log_path or ""))
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - _STEP_TAIL_BYTES))
            tail = f.read().decode("utf-8", "replace")
        mtime = path.stat().st_mtime
    except (OSError, ValueError):
        return None, ""
    lines = [ln for ln in tail.splitlines() if ln.strip()]
    if not lines:
        return mtime, ""
    return mtime, _shorten(lines[-1])


def _status(task, completed, age_s):
    """The dashboard's status word for one child, from what the manifest actually says."""
    raw = str((task or {}).get("status") or "").strip().lower()
    if raw in _DONE or (completed and not raw):
        return "done"
    if raw in _GONE:
        return "failed"
    if raw and raw != "running":
        return "failed"                                   # unknown terminal word
    if completed:
        return "done"
    if age_s is not None and age_s > _STALE_AFTER_S:
        return "stalled"
    return "running"


def snapshot(limit=40, profile_home=None, now=None):
    """One entry per delegated child, newest batch first. Read-only; never raises.

    Shape matches the helper-job entries the Agents tab already renders, so the two kinds
    can be merged, minus ``name`` — the caller names them with the one existing helper so
    there is a single naming rule.
    """
    now = time.time() if now is None else now
    try:
        manifests = sorted(live_root(profile_home).glob("*/manifest.json"),
                           key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return []

    out = []
    for path in manifests:
        try:
            m = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            continue
        if not isinstance(m, dict):
            continue
        delegation_id = str(m.get("delegation_id") or path.parent.name)
        completed = bool(m.get("completed"))
        finished = _epoch(m.get("completed"))
        started = _epoch(m.get("started")) or path.stat().st_mtime
        tasks = m.get("tasks")
        for task in (tasks if isinstance(tasks, list) else []):
            if not isinstance(task, dict):
                continue
            step_at, step = _last_step(task.get("log"))
            age = None if step_at is None else max(0.0, now - step_at)
            goal = " ".join(str(task.get("goal") or "").split())
            out.append(dict(
                id=f"{delegation_id}-{task.get('index')}",
                kind="delegation",
                delegation_id=delegation_id,
                index=task.get("index"),
                brief=goal,
                status=_status(task, completed, age),
                step=step,
                step_at=step_at,
                started=started,
                finished=finished,
                elapsed=max(0.0, (finished or now) - started) if started else None,
                result=str(task.get("exit_reason") or ""),
                model=str(task.get("model") or m.get("model") or ""),
                log=str(task.get("log") or ""),
                stoppable=False,                          # the dashboard cannot stop these
                quiet=False,
                diagnostic=False,
            ))

    out.sort(key=lambda a: (a["status"] not in ("running", "stalled"), -(a["started"] or 0)))
    return out[:limit]
