"""Hermes API-server backend (default when it answers: JARVIS_BACKEND=auto).

Why this exists: the default backend runs `hermes chat -q` as a one-shot
subprocess, and in that mode Hermes never *asks* about a flagged command — it
blocks it (or, with --yolo, allows everything). The Hermes API server is the
one surface with a real per-command approval channel:

    POST /v1/runs                      start a run
    GET  /v1/runs/{id}/events          SSE: message.delta, tool.*, approval.request, run.*
    POST /v1/runs/{id}/approval        {"choice": "once"|"deny", "request_id": ...}

This module turns that stream into the same event dicts the UI already
understands (delta / tool / usage / complete / error) plus one new event,
`approval`, and forwards the user's answer back to Hermes.

Safety rules baked in here (not left to the UI):
  * Only "once" and "deny" can be sent. "session"/"always" are never accepted
    from the dashboard, so a spoken "yes" can never become a standing rule.
  * Anything unclear, late or unanswered resolves to deny (Hermes also times out to deny).
"""
import json
import re
import threading
import time
import urllib.error
import urllib.request

ALLOWED_CHOICES = {"once", "deny"}

# Descriptions/commands that deserve a deliberate keypress rather than a spoken "yes".
_HIGH_RISK = re.compile(
    r"(delet|remove|rm\s|rmdir|wipe|erase|format|overwrit|truncate|force|--hard|reset|"
    r"sudo|chmod|chown|kill|pkill|shutdown|reboot|drop\s|"
    r"send|email|mail|message|post|publish|push|deploy|"
    r"purchase|buy|pay|transfer|charge|"
    r"curl[^|]*\|\s*(ba)?sh|pipe to shell|credential|secret|password|token|ssh|\.env)",
    re.I,
)

_LOCK = threading.Lock()
_ACTIVE = {"run_id": None}


def classify(description="", command=""):
    """'high' = needs a hands-on confirm (key/click); 'normal' = a spoken yes is fine."""
    return "high" if _HIGH_RISK.search(f"{description} {command}") else "normal"


_LOW_RISK = re.compile(
    r"^\s*(ls|cat|head|tail|pwd|find|grep|rg|git\s+(status|log|diff|show|branch)|"
    r"echo|which|whoami|date|uptime|wc|du|df|stat)\b",
    re.I,
)
_MED_RISK = re.compile(
    r"(write|edit|patch|mkdir|touch|cp\s|mv\s|install|pip\s|npm\s|brew\s|"
    r"git\s+(add|commit|checkout|switch|merge|stash)|sed\s|awk\s|tee\s|>)",
    re.I,
)


def classify_tier(description="", command=""):
    """Return {'tier': 'low'|'medium'|'high', 'reason': str} for the UI risk badge."""
    blob = f"{description} {command}".strip()
    m = _HIGH_RISK.search(blob)
    if m:
        tok = m.group(0).strip()
        if re.search(r"send|email|mail|message|post|publish|push|deploy", tok, re.I):
            why = "Sends, publishes, or deploys externally — requires keyboard or tap confirmation."
        elif re.search(r"purchase|buy|pay|transfer|charge", tok, re.I):
            why = "Spends or moves money — requires deliberate keyboard or tap confirmation."
        elif re.search(r"credential|secret|password|token|ssh|\.env", tok, re.I):
            why = "Touches credentials or secrets — requires deliberate keyboard or tap confirmation."
        else:
            why = f"Destructive or privileged operation ({tok}) — spoken 'yes' disabled; confirm with keyboard or tap."
        return {"tier": "high", "reason": why}
    if _LOW_RISK.search(command or "") and not _MED_RISK.search(blob):
        return {"tier": "low", "reason": "Read-only inspection — does not modify files, send messages, or spend money."}
    return {"tier": "medium", "reason": "Modifies local files, packages, or workspace state — safe to approve by voice or tap."}


def _headers(key):
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = "Bearer " + key
    return h


def _post(base, key, path, body, timeout=20):
    req = urllib.request.Request(base + path, json.dumps(body).encode(), _headers(key), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def healthy(base, timeout=1.5):
    try:
        with urllib.request.urlopen(base + "/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def active_run_id():
    with _LOCK:
        return _ACTIVE["run_id"]


def cancel_active(base, key):
    rid = active_run_id()
    if not rid:
        return False
    try:
        _post(base, key, f"/v1/runs/{rid}/stop", {}, timeout=5)
        return True
    except Exception:
        return False


def resolve_approval(base, key, run_id, request_id, choice):
    """Forward the user's answer. Returns (ok, payload_or_error)."""
    choice = str(choice or "").strip().lower()
    if choice not in ALLOWED_CHOICES:
        return False, "choice must be 'once' or 'deny'"
    if not run_id or not re.fullmatch(r"[A-Za-z0-9_\-]{1,128}", str(run_id)):
        return False, "bad run id"
    body = {"choice": choice}
    if request_id:
        body["request_id"] = str(request_id)[:256]
    try:
        return True, _post(base, key, f"/v1/runs/{run_id}/approval", body)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        return False, msg or f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def run(message, session_id, instructions=None, *, base, key, idle_timeout, approval_timeout=100,
        valid_session=lambda s: False, mono_ms=lambda: int(time.monotonic() * 1000),
        profile="default", permission="normal", auto_approve=False):
    """Generator of dashboard events for one turn, driven by the Hermes API server."""
    started = mono_ms()
    # `instructions` is Hermes' per-turn system prompt; `session_id` continues a
    # conversation (Hermes loads its transcript). With no session, the run id becomes it.
    body = {"input": message}
    if instructions:
        body["instructions"] = instructions
    if valid_session(session_id):
        body["session_id"] = str(session_id)
    while True:
        try:
            run_info = _post(base, key, "/v1/runs", body, timeout=30)
            break
        except urllib.error.HTTPError as e:
            if e.code == 409 and "session_id" in body:
                # That conversation belongs to another Hermes surface (e.g. the CLI backend):
                # carry on in a fresh thread rather than failing the turn.
                body.pop("session_id")
                session_id = None
                yield dict(t="note", message="Started a fresh Hermes thread on the API server.")
                continue
            yield dict(t="error", message=f"Hermes API refused the run (HTTP {e.code}). Check JARVIS_API_KEY.")
            return
        except Exception as e:  # noqa: BLE001
            yield dict(t="error", message=f"Hermes API unreachable: {str(e)[:200]}")
            return

    run_id = run_info.get("run_id")
    if not run_id:
        yield dict(t="error", message="Hermes API returned no run id.")
        return
    with _LOCK:
        _ACTIVE["run_id"] = run_id

    yield dict(t="status", model="Hermes API", tools=0, mcp=[], permission=permission,
               profile=profile, runtime="hermes", session_id=session_id, backend="api")

    first, text_seen, completed = True, False, False
    final_session = session_id if valid_session(session_id) else run_id
    # Reads can legitimately sit idle while a human decides, so allow for that.
    read_timeout = max(idle_timeout, approval_timeout + 30)
    try:
        req = urllib.request.Request(base + f"/v1/runs/{run_id}/events", headers=_headers(key))
        with urllib.request.urlopen(req, timeout=read_timeout) as stream:
            for raw in stream:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                name = ev.get("event", "")

                if name == "message.delta":
                    if first:
                        first = False
                        yield dict(t="latency", ms=mono_ms() - started)
                    text_seen = True
                    yield dict(t="delta", text=ev.get("delta") or "")
                elif name == "tool.started":
                    yield dict(t="tool", phase="use", name=ev.get("tool") or "tool",
                               input=str(ev.get("preview") or "")[:200])
                elif name == "tool.completed":
                    yield dict(t="tool", phase="result", name=ev.get("tool") or "tool",
                               ok=not bool(ev.get("error")))
                elif name == "approval.request":
                    desc = str(ev.get("description") or "a flagged action")
                    cmd = str(ev.get("command") or "")
                    if auto_approve:      # "bypass" permission mode: same trust level as --yolo, but logged
                        resolve_approval(base, key, run_id, ev.get("request_id"), "once")
                        yield dict(t="note", message=f"Bypass mode: auto-approved {desc}"[:200])
                        continue
                    info = classify_tier(desc, cmd)
                    yield dict(t="approval", run_id=run_id, request_id=ev.get("request_id"),
                               description=desc, command=cmd[:400],
                               risk=classify(desc, cmd), risk_tier=info["tier"],
                               reason=info["reason"], timeout=approval_timeout)
                elif name == "approval.responded":
                    yield dict(t="approval_done", request_id=ev.get("request_id"),
                               choice=ev.get("choice"))
                elif name == "run.completed":
                    completed = True
                    u = ev.get("usage") or {}
                    if u:
                        yield dict(t="usage", input_tokens=u.get("input_tokens"),
                                   output_tokens=u.get("output_tokens"),
                                   total_tokens=u.get("total_tokens"),
                                   cache_read=u.get("cache_read_tokens"),
                                   cache_write=u.get("cache_write_tokens"))
                    out = ev.get("output") or ""
                    if not text_seen and out:
                        yield dict(t="delta", text=out)
                    yield dict(t="complete", session_id=final_session, text=out,
                               ms=mono_ms() - started)
                    break
                elif name in ("run.failed", "run.cancelled", "run.stopped", "run.interrupted"):
                    completed = True
                    why = ev.get("error") or ev.get("reason") or name.replace("run.", "")
                    yield dict(t="error", message=f"Hermes run {why}"[:300])
                    break
        if not completed:
            yield dict(t="error", message="Hermes stream ended before the run finished.")
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"Hermes stream error: {str(e)[:200]}")
    finally:
        with _LOCK:
            if _ACTIVE["run_id"] == run_id:
                _ACTIVE["run_id"] = None
