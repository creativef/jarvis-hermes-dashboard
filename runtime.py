"""
Hermes runtime for the JARVIS HUD.

This dashboard is a face on Hermes Agent, not Claude Code. It launches the
Hermes CLI with the selected profile/source so Hermes keeps access to the same
configured toolsets, MCP servers, browser automation, Google integrations,
third-party tools, skills, memory, and gateway features that are available to the
normal Hermes agent.

The CLI is driven in `--format stream-json` mode, which emits newline-delimited
JSON events on stdout (verified against Hermes v0.22.2):

    {"type":"system","subtype":"init","model":...,"session_id":...}
    {"type":"text","text":...}                       # token-level streaming
    {"type":"tool_use","name":...,"input":{...}}
    {"type":"tool_result","name":...,"output":...,"is_error":...,"duration_ms":...}
    {"type":"result","session_id":...,"exit_code":...,"text":...,"tokens":{...}}

Session IDs, token usage, and tool telemetry are first-class fields, so the
dashboard never parses CLI prose. stderr carries a `session_id:` echo plus a
`↻ Resumed session ...` line and is ignored entirely in this mode.

Set HERMES_CMD when your shell exposes Hermes under a custom command/path, e.g.
  HERMES_CMD="/path/to/hermes"
or
  HERMES_CMD="python3 -m hermes_cli.main"
"""
import collections
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$")

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
PROFILE = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default")).strip() or "default"
SOURCE = os.environ.get("HERMES_SOURCE", "jarvis-dashboard").strip() or "jarvis-dashboard"
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
PERMISSION = os.environ.get("JARVIS_PERMISSION", os.environ.get("HERMES_PERMISSION", "normal")).strip().lower()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()  # auto|hermes|mock
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "120"))
# Raw transcripts can contain private prompts. Logging is off by default.
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "").strip()
TOOLSETS = os.environ.get("HERMES_TOOLSETS", "").strip()


def apply_settings(settings):
    """Apply UI-supplied settings to the runtime globals (no restart needed)."""
    global PERMISSION, IDLE_TIMEOUT, WORKDIR
    if settings.get("permission"):
        PERMISSION = str(settings["permission"]).strip().lower()
    if settings.get("timeout"):
        try:
            IDLE_TIMEOUT = int(settings["timeout"])
        except (TypeError, ValueError):
            pass
    if settings.get("workdir"):
        WORKDIR = os.path.expanduser(str(settings["workdir"]).strip())


def current_settings():
    return {"permission": PERMISSION, "timeout": IDLE_TIMEOUT, "workdir": WORKDIR}


# One Hermes subprocess at a time. Hermes session state and profile resources are
# shared, so foreground runs and /background missions must not overlap. The active
# process handle lets the browser Escape key stop the backend work, not just the
# frontend fetch.
EXECUTION_LOCK = threading.RLock()
_ACTIVE_PROC = None
_ACTIVE_LOCK = threading.Lock()

# Runtime probes (`hermes --version`, `hermes tools list`) are subprocess spawns
# that can each take tens of seconds; cache them briefly so every request does
# not re-pay that cost.
_TTL_CACHE = {}
_TTL_LOCK = threading.Lock()
_PROBE_TTL = 60.0


def _ttl_cached(key, ttl, fn, *args):
    now = time.monotonic()
    with _TTL_LOCK:
        hit = _TTL_CACHE.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = fn(*args)
    with _TTL_LOCK:
        _TTL_CACHE[key] = (now, value)
    return value


def cancel_active():
    """Terminate the currently running Hermes child process, if any."""
    with _ACTIVE_LOCK:
        proc = _ACTIVE_PROC
    if proc is None or proc.poll() is not None:
        return False
    try:
        proc.terminate()
    except Exception:
        return False
    # Escalate to SIGKILL if the process ignores SIGTERM (e.g. a hung tool call),
    # so the execution lock is never held hostage by a process that won't die.
    def _escalate():
        time.sleep(2.0)
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass
    threading.Thread(target=_escalate, daemon=True).start()
    return True


def valid_session(sid):
    # Hermes emits timestamp-based IDs such as 20260808_031038_0ecb14.
    return bool(sid) and bool(_SESSION_ID.match(str(sid)))


def _mono_ms():
    return int(time.monotonic() * 1000)


def _hermes_base():
    configured = os.environ.get("HERMES_CMD", "").strip()
    if configured:
        return shlex.split(configured)
    exe = shutil.which("hermes")
    if exe:
        return [exe]
    # Last-resort module invocation; start.sh prepends common Python bin dirs.
    return ["python3", "-m", "hermes_cli.main"]


def _can_launch_hermes():
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["--version"], cwd=WORKDIR, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=12)
        return proc.returncode == 0, (proc.stdout or proc.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def runtime_kind():
    if RUNTIME == "mock":
        return "mock"
    if RUNTIME == "hermes":
        return "hermes"
    ok, _ = _ttl_cached("hermes_version", _PROBE_TTL, _can_launch_hermes)
    return "hermes" if ok else "mock"


def build_prompt(message, system=None):
    # Hermes chat has no separate --system flag (verified v0.22.2), so the voice
    # persona and the request are combined into one explicit turn. This stops the
    # model answering as a coding agent that narrates its own machinery.
    if not system:
        return message
    return (f"{system}\n\n## Current user request\n{message}\n\n"
            "Answer the request now. Return only the words JARVIS should say aloud; "
            "never include session IDs, runtime metadata, headings, or process narration.")


def build_command(message, session_id=None):
    # --format stream-json = structured NDJSON on stdout (implies --quiet).
    # --query-file - reads the prompt from stdin, the documented-safe way to pass
    # arbitrary text (nothing is shell-interpreted, no argv length limits).
    cmd = _hermes_base() + ["chat", "--format", "stream-json", "--query-file", "-",
                            "--source", SOURCE]
    if valid_session(session_id):
        cmd += ["--resume", str(session_id)]
    if MODEL:
        cmd += ["--model", MODEL]
    if TOOLSETS:
        cmd += ["--toolsets", TOOLSETS]
    # JARVIS_PERMISSION=bypass maps to Hermes --yolo (skip dangerous-command
    # approval). Other modes use Hermes's default approval behaviour.
    if PERMISSION == "bypass":
        cmd += ["--yolo"]
    # NOTE: profile selection is via the HERMES_PROFILE env var (inherited below),
    # not a `chat` flag — `--profile` is a GLOBAL flag and is invalid after `chat`.
    return cmd


def hermes_tools_snapshot(limit=36):
    """Return a compact list of enabled/visible Hermes toolsets/tools for UI status."""
    return _ttl_cached("tools_snapshot", _PROBE_TTL, _tools_snapshot_raw, limit)


def _tools_snapshot_raw(limit=36):
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["tools", "list"], cwd=WORKDIR, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=20)
        out = (proc.stdout or proc.stderr or "").strip()
        tools = []
        for line in out.splitlines():
            clean = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if not clean or clean.startswith(("Usage", "─", "=")):
                continue
            if any(tok in clean.lower() for tok in ("enabled", "available", "tool", "browser", "terminal", "file", "google", "github", "web", "voice")):
                tools.append(clean[:80])
            if len(tools) >= limit:
                break
        return tools or [out[:120]] if out else []
    except Exception:
        return []


def run_hermes(message, session_id=None, system=None):
    with EXECUTION_LOCK:
        yield from _run_hermes_locked(message, session_id, system)


def _run_hermes_locked(message, session_id=None, system=None):
    global _ACTIVE_PROC
    started = _mono_ms()
    cmd = build_command(message, session_id)
    prompt = build_prompt(message, system)
    yield dict(t="status", model=MODEL or "Hermes default", tools=len(hermes_tools_snapshot()),
               mcp=[], permission=PERMISSION, profile=PROFILE, runtime="hermes",
               session_id=session_id)

    child_env = dict(os.environ)
    # Profile selection is env-based; the dashboard's own JARVIS_PROFILE override
    # must be propagated to the child.
    child_env["HERMES_PROFILE"] = PROFILE
    # Ensure GUI-started shells can still find common Homebrew/user installs.
    home = os.path.expanduser("~")
    child_env["PATH"] = ":".join(dict.fromkeys([
        child_env.get("PATH", ""),
        "/opt/homebrew/bin", "/usr/local/bin",
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".npm-global", "bin"),
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ]))

    try:
        proc = subprocess.Popen(cmd, cwd=WORKDIR, text=True, bufsize=1,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=child_env)
        with _ACTIVE_LOCK:
            _ACTIVE_PROC = proc
    except FileNotFoundError:
        raise RuntimeError("Hermes CLI not found. Set HERMES_CMD to your Hermes executable.")

    q = collections.deque()
    lock = threading.Lock()
    done = threading.Event()
    errbuf = collections.deque(maxlen=120)
    raw = None
    if RAW_LOG:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(os.path.expanduser(RAW_LOG), flags, 0o600)
        os.fchmod(fd, 0o600)
        raw = os.fdopen(fd, "w", encoding="utf-8", errors="replace")
        raw.write("$ " + " ".join(shlex.quote(x) for x in cmd) + "\n\n")
        raw.flush()

    def pump_stdout():
        try:
            for ln in proc.stdout:
                if raw:
                    raw.write("OUT " + ln)
                    raw.flush()
                with lock:
                    q.append(ln)
        finally:
            done.set()

    def pump_stderr():
        try:
            for ln in proc.stderr:
                if raw:
                    raw.write("ERR " + ln)
                    raw.flush()
                errbuf.append(ln.rstrip())
        except Exception:
            pass

    # Drain stdout/stderr FIRST so a large prompt write can't deadlock on a full
    # pipe, then hand the query to stdin and close it.
    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()
    if proc.stdin is not None:
        try:
            proc.stdin.write(prompt)
            proc.stdin.flush()
        except OSError:
            pass  # Hermes may have already exited on bad args; the loop reports it.
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    first = True
    last = time.monotonic()
    text_seen = False
    completed = False
    result_session = None
    in_tool = False
    try:
        while not done.is_set() or q:
            line = None
            with lock:
                if q:
                    line = q.popleft()
            if line is None:
                if proc.poll() is not None and done.is_set():
                    break
                if time.monotonic() - last > IDLE_TIMEOUT and not in_tool:
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except Exception:
                        pass
                    err = " | ".join(list(errbuf)[-3:])
                    yield dict(t="error", message=(f"Hermes went quiet for {IDLE_TIMEOUT}s and was stopped. " + err)[:400])
                    return
                time.sleep(0.05)
                continue
            last = time.monotonic()
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue  # never let one malformed frame kill the whole stream
            etype = ev.get("type")
            if etype == "system":
                # init frame carries session_id/model; nothing to display yet
                continue
            if etype == "text":
                if first:
                    first = False
                    yield dict(t="latency", ms=_mono_ms() - started)
                text_seen = True
                yield dict(t="delta", text=ev.get("text") or "")
                continue
            if etype == "tool_use":
                in_tool = True
                name = ev.get("name") or "tool"
                inp = ev.get("input")
                yield dict(t="tool", phase="use", name=name,
                           input=(json.dumps(inp, ensure_ascii=False)[:200] if inp else ""))
                continue
            if etype == "tool_result":
                in_tool = False
                yield dict(t="tool", phase="result", name=ev.get("name") or "tool",
                           ok=not bool(ev.get("is_error")))
                continue
            if etype == "result":
                completed = True
                result_session = ev.get("session_id")
                tokens = ev.get("tokens") or {}
                if tokens:
                    yield dict(t="usage", input_tokens=tokens.get("input"),
                               output_tokens=tokens.get("output"),
                               total_tokens=tokens.get("total"),
                               cache_read=tokens.get("cache_read"),
                               cache_write=tokens.get("cache_write"))
                final_text = ev.get("text") or ""
                rc = ev.get("exit_code", 0)
                if rc != 0:
                    err = " | ".join(list(errbuf)[-6:])
                    yield dict(t="error", message=(err or f"Hermes exited with code {rc}")[:500])
                    return
                if not text_seen and final_text:
                    yield dict(t="delta", text=final_text)
                yield dict(t="complete", session_id=result_session or session_id,
                           text=final_text, ms=_mono_ms() - started)

        rc = proc.wait(timeout=5)
        if not completed:
            if rc != 0:
                err = " | ".join(list(errbuf)[-6:])
                yield dict(t="error", message=(err or f"Hermes exited with code {rc}")[:500])
            else:
                yield dict(t="delta", text="Hermes completed without textual output.")
                yield dict(t="complete", session_id=result_session or session_id,
                           ms=_mono_ms() - started)
    finally:
        try:
            if raw:
                raw.close()
        except Exception:
            pass
        if proc.poll() is None:
            proc.terminate()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass
        with _ACTIVE_LOCK:
            if _ACTIVE_PROC is proc:
                _ACTIVE_PROC = None


def run_mock(message, session_id=None, system=None):
    ok, detail = _can_launch_hermes()
    yield dict(t="error", message=("Hermes is not reachable from this dashboard process. "
                                   "Set HERMES_CMD or start from a shell where `hermes` works. "
                                   f"Diagnostic: {detail[:240]}"))


def run(message, session_id=None, system=None):
    if runtime_kind() != "hermes":
        yield from run_mock(message, session_id, system)
        return
    try:
        yield from run_hermes(message, session_id, system)
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Hermes core: {e}")
