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
import getpass
import json
import os
import pathlib
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
# Optional backend with real per-command approvals (see api_backend.py).
BACKEND = os.environ.get("JARVIS_BACKEND", "cli").strip().lower()      # cli | api
API_URL = os.environ.get("JARVIS_API_URL", "http://127.0.0.1:8642").strip().rstrip("/")
API_KEY = os.environ.get("JARVIS_API_KEY", "").strip()


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
    return {"permission": PERMISSION, "timeout": IDLE_TIMEOUT, "workdir": WORKDIR,
            **model_info()}


def _profile_home():
    base = os.path.expanduser(os.environ.get("HERMES_HOME") or "~/.hermes")
    if PROFILE and PROFILE != "default":
        return pathlib.Path(base) / "profiles" / PROFILE
    return pathlib.Path(base)


def model_info():
    """Provider + model Hermes will actually use, read from the profile's config.yaml.

    Read-only and dependency-free: scans only the top-level `model:` block.
    JARVIS_MODEL (the --model override) wins over the configured default.
    """
    key = ("model_info", str(_profile_home()), MODEL)
    return _ttl_cached(key, _PROBE_TTL, _model_info_raw)


def _model_info_raw():
    provider = name = ""
    try:
        text = (_profile_home() / "config.yaml").read_text(encoding="utf-8")
        block = re.search(r"^model:[ \t]*\n((?:[ \t]+.*\n?|\n)*)", text, re.M)
        if block:
            for key, val in re.findall(r"^[ \t]+(default|provider):[ \t]*(\S+)", block.group(1), re.M):
                val = val.strip("'\"")
                if key == "default":
                    name = val
                else:
                    provider = val
        else:
            m = re.search(r"^model:[ \t]*(\S+)", text, re.M)
            if m:
                name = m.group(1).strip("'\"")
    except OSError:
        pass
    if MODEL:
        name = MODEL
    return {"model_provider": provider or "Hermes default", "model_name": name or "Hermes default"}


def user_name():
    """Best-effort the user's name from Hermes memory, falling back to the OS user."""
    key = ("user_name", str(_profile_home()))
    return _ttl_cached(key, _PROBE_TTL, _user_name_raw)


def _user_name_raw():
    for rel in ("memories/USER.md", "SOUL.md"):
        try:
            text = (_profile_home() / rel).read_text(encoding="utf-8")
        except OSError:
            continue
        m = re.search(r"(?:name is|name:|owner:)\s*([A-Za-z][A-Za-z0-9' -]{1,40})", text, re.I)
        if m:
            name = m.group(1).strip().split(".")[0].strip()
            return " ".join(name.split()[:2])
    name = getpass.getuser()
    return name[:1].upper() + name[1:] if name else name


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
_RESPONSE_CACHE = {}
_TTL_LOCK = threading.Lock()
_PROBE_TTL = float(os.environ.get("JARVIS_PROBE_TTL", "60"))
RESPONSE_TTL = float(os.environ.get("JARVIS_CACHE_TTL", "120"))

_CACHEABLE_RE = re.compile(
    r"\b(status|brief|morning\s+brief|daily\s+brief|evening\s+wrap|overview|summary|"
    r"departments|teams|store\s+numbers|today'?s\s+numbers|calendar|weather|health|"
    r"what'?s\s+on\s+today|what\s+is\s+on\s+today|standup|standing\s+objective)\b",
    re.I,
)

_ABBREVS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
    "e.g", "i.e", "fig", "no", "vol", "inc", "ltd", "co", "corp",
}
_FILE_STEMS = {
    "runtime", "commands", "voice", "server", "brain", "team", "handoff",
    "app", "index", "styles", "themes", "config", "state", "www", "http", "https",
}

ACK_PHRASES = {
    "default": "On it.",
    "status": "Checking status.",
    "sales": "On it, checking the store.",
    "team": "On it, checking with the team.",
    "search": "Looking into that now.",
    "workspace": "On it, checking the workspace.",
    "brief": "Pulling up your brief.",
}


def classify_ack_intent(message=""):
    q = (message or "").strip().lower()
    if not q:
        return "default"
    if any(w in q for w in ("sale", "order", "refund", "shopify", "store", "roas", "ad spend", "pod", "margin", "revenue")):
        return "sales"
    if any(w in q for w in ("brief", "morning", "today", "schedule", "calendar", "plan", "summary")):
        return "brief"
    if any(w in q for w in ("team", "department", "notebook", "commons", "marketing", "finance", "operations")):
        return "team"
    if any(w in q for w in ("status", "health", "online", "latency", "job", "agent", "mission")):
        return "status"
    if any(w in q for w in ("search", "research", "find", "look up", "web", "browser", "check")):
        return "search"
    if any(w in q for w in ("code", "file", "test", "build", "fix", "repo", "git", "deploy")):
        return "workspace"
    return "default"


def ack_phrase(message=""):
    if message in ACK_PHRASES:
        return ACK_PHRASES[message]
    return ACK_PHRASES.get(classify_ack_intent(message), ACK_PHRASES["default"])


class SentenceBuffer:
    """Incremental sentence splitter for token-streamed model output."""

    def __init__(self):
        self.buf = ""
        self.index = 0

    @staticmethod
    def _is_false_period(prefix, punct):
        if not punct.startswith("."):
            return False
        m = re.search(r"([A-Za-z0-9.]+)$", prefix)
        if not m:
            return False
        word = m.group(1).lower().rstrip(".")
        if word in _ABBREVS or word in _FILE_STEMS:
            return True
        if word.isdigit() or (len(word) == 1 and word.isalpha()):
            return True
        return False

    def feed(self, chunk):
        """Append `chunk` and return a list of newly completed sentences."""
        if not chunk:
            return []
        self.buf += chunk
        out = []
        while True:
            split_at = None
            next_start = None
            for m in re.finditer(r'([.!?]+["\')\]]?)(\s+)|\n+', self.buf):
                if m.group(0).startswith("\n"):
                    if self.buf[:m.start()].strip():
                        split_at = m.start()
                        next_start = m.end()
                        break
                    continue
                punct = m.group(1)
                if self._is_false_period(self.buf[:m.start(1)], punct):
                    continue
                split_at = m.end(1)
                next_start = m.end(2)
                break
            if split_at is None:
                break
            sent = self.buf[:split_at].strip()
            self.buf = self.buf[next_start:]
            if sent:
                out.append((self.index, sent))
                self.index += 1

        # Also check if buffer ends cleanly at a sentence-closing punctuation
        # (e.g., when a single delta event contains a full sentence without trailing space).
        stripped = self.buf.strip()
        m_end = re.search(r'([A-Za-z]{2,})([.!?]+["\')\]]?)$', stripped)
        if m_end and len(stripped) >= 4:
            punct = m_end.group(2)
            prefix = stripped[:m_end.start(2)]
            if not self._is_false_period(prefix, punct):
                self.buf = ""
                out.append((self.index, stripped))
                self.index += 1
        return out

    def flush(self):
        """Flush any remaining trailing text at stream completion."""
        rem = self.buf.strip()
        self.buf = ""
        if not rem:
            return []
        idx = self.index
        self.index += 1
        return [(idx, rem)]


def split_sentences(text):
    """Split a full text string into sentence chunks using SentenceBuffer."""
    sb = SentenceBuffer()
    sents = [s for _, s in sb.feed(text or "")]
    sents.extend(s for _, s in sb.flush())
    return sents


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


def _norm_cache_key(query, profile=None):
    q = " ".join((query or "").strip().split()).lower().strip("?!.,;:'\" ")
    return (q, (profile or PROFILE))


def is_cacheable_query(message):
    """True for repeat status/brief/summary queries that benefit from TTL caching."""
    q = " ".join((message or "").strip().split())
    if not q or len(q) > 240:
        return False
    return bool(_CACHEABLE_RE.search(q))


def cache_get(query, profile=None):
    key = _norm_cache_key(query, profile)
    now = time.monotonic()
    with _TTL_LOCK:
        entry = _RESPONSE_CACHE.get(key)
        if entry is None:
            return None
        if now - entry["at"] >= entry["ttl"]:
            _RESPONSE_CACHE.pop(key, None)
            return None
        return dict(entry)


def cache_set(query, text, session_id=None, ttl=None, profile=None):
    if not (text or "").strip():
        return
    key = _norm_cache_key(query, profile)
    entry = {
        "text": text,
        "session_id": session_id,
        "at": time.monotonic(),
        "ttl": RESPONSE_TTL if ttl is None else float(ttl),
    }
    with _TTL_LOCK:
        _RESPONSE_CACHE[key] = entry


def cache_invalidate(query=None, profile=None):
    with _TTL_LOCK:
        if query is None:
            _RESPONSE_CACHE.clear()
        else:
            _RESPONSE_CACHE.pop(_norm_cache_key(query, profile), None)


def clear_cache():
    """Clear both the probe TTL cache and the response TTL cache."""
    with _TTL_LOCK:
        _TTL_CACHE.clear()
        _RESPONSE_CACHE.clear()


def seed_probe_cache(*, version_ok=True, version_detail="Hermes Agent (cached)",
                     tools=None, model=None, user=None, ttl=None):
    """Pre-populate the runtime probe cache without spawning subprocesses."""
    now = time.monotonic()
    if ttl is not None:
        # shift timestamp so custom ttl works against _PROBE_TTL
        now = now - _PROBE_TTL + float(ttl)
    with _TTL_LOCK:
        _TTL_CACHE["hermes_version"] = (now, (bool(version_ok), str(version_detail)))
        if tools is not None:
            _TTL_CACHE["tools_snapshot"] = (now, list(tools))
        if model is not None:
            _TTL_CACHE[("model_info", str(_profile_home()), MODEL)] = (now, dict(model))
        if user is not None:
            _TTL_CACHE[("user_name", str(_profile_home()))] = (now, str(user))


def probe_cache_status():
    """Return warm status and remaining TTL (seconds) for runtime probes."""
    now = time.monotonic()
    keys = {
        "hermes_version": "hermes_version",
        "tools_snapshot": "tools_snapshot",
        "model_info": ("model_info", str(_profile_home()), MODEL),
        "user_name": ("user_name", str(_profile_home())),
    }
    out = {}
    with _TTL_LOCK:
        for label, k in keys.items():
            hit = _TTL_CACHE.get(k)
            if hit and (now - hit[0]) < _PROBE_TTL:
                out[label] = {"warm": True, "ttl_remaining": round(_PROBE_TTL - (now - hit[0]), 2)}
            else:
                out[label] = {"warm": False, "ttl_remaining": 0.0}
    return out


def prewarm_probes(background=False):
    """Pre-warm `hermes --version`, `hermes tools list`, model_info, and user_name caches."""
    def _warm():
        runtime_kind()
        hermes_tools_snapshot()
        model_info()
        user_name()
        return probe_cache_status()

    if background:
        t = threading.Thread(target=_warm, daemon=True)
        t.start()
        return probe_cache_status()
    return _warm()


def api_backend_ready():
    import api_backend
    return BACKEND == "api" and api_backend.healthy(API_URL)


def resolve_approval(run_id, request_id, choice):
    import api_backend
    return api_backend.resolve_approval(API_URL, API_KEY, run_id, request_id, choice)


def cancel_active():
    """Terminate the currently running Hermes child process, if any."""
    if BACKEND == "api":
        import api_backend
        if api_backend.cancel_active(API_URL, API_KEY):
            return True
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
            "Answer the request now. Return only the words ATLAS should say aloud; "
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


def run_background(message, system=None):
    """Run a mission in its own Hermes process, outside the execution lock, so the
    foreground conversation is never blocked or interrupted by it."""
    yield from _run_hermes_locked(message, None, system, background=True)


def _run_hermes_locked(message, session_id=None, system=None, background=False):
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
        if not background:
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
    sbuf = SentenceBuffer()
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
                chunk = ev.get("text") or ""
                yield dict(t="delta", text=chunk)
                for s_idx, sent in sbuf.feed(chunk):
                    yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
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
                    for s_idx, sent in sbuf.feed(final_text):
                        yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
                for s_idx, sent in sbuf.flush():
                    yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
                yield dict(t="complete", session_id=result_session or session_id,
                           text=final_text, ms=_mono_ms() - started)

        rc = proc.wait(timeout=5)
        if not completed:
            if rc != 0:
                err = " | ".join(list(errbuf)[-6:])
                yield dict(t="error", message=(err or f"Hermes exited with code {rc}")[:500])
            else:
                fallback = "Hermes completed without textual output."
                yield dict(t="delta", text=fallback)
                yield dict(t="sentence", text=fallback, index=0, ms=_mono_ms() - started)
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
    # Immediate acknowledgement event before any model startup or response.
    intent = classify_ack_intent(message)
    yield dict(t="ack", text=ack_phrase(intent), intent=intent, ms=0)

    cacheable = is_cacheable_query(message)
    if cacheable:
        hit = cache_get(message)
        if hit is not None:
            text = hit["text"]
            sid = hit.get("session_id") or session_id
            yield dict(t="status", model=MODEL or "Hermes default",
                       tools=len(hermes_tools_snapshot()), mcp=[],
                       permission=PERMISSION, profile=PROFILE, runtime="hermes",
                       session_id=sid, cached=True)
            yield dict(t="latency", ms=0, cached=True)
            yield dict(t="delta", text=text, cached=True)
            for idx, sent in enumerate(split_sentences(text)):
                yield dict(t="sentence", text=sent, index=idx, ms=0, cached=True)
            yield dict(t="complete", session_id=sid, text=text, ms=0, cached=True)
            return

    if runtime_kind() != "hermes":
        yield from run_mock(message, session_id, system)
        return
    try:
        if BACKEND == "api":
            if api_backend_ready():
                import api_backend
                sbuf = SentenceBuffer()
                started = _mono_ms()
                collected = []
                with EXECUTION_LOCK:
                    for ev in api_backend.run(
                        message, session_id, build_prompt(message, system),
                        base=API_URL, key=API_KEY, idle_timeout=IDLE_TIMEOUT,
                        valid_session=valid_session, mono_ms=_mono_ms,
                        profile=PROFILE, permission=PERMISSION,
                        auto_approve=(PERMISSION == "bypass"),
                    ):
                        if ev.get("t") == "delta":
                            chunk = ev.get("text") or ""
                            collected.append(chunk)
                            yield ev
                            for s_idx, sent in sbuf.feed(chunk):
                                yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
                        elif ev.get("t") == "complete":
                            for s_idx, sent in sbuf.flush():
                                yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
                            final_text = ev.get("text") or "".join(collected)
                            if cacheable and final_text:
                                cache_set(message, final_text, ev.get("session_id") or session_id)
                            yield ev
                        else:
                            yield ev
                return
            yield dict(t="note", message="Hermes API server isn't reachable, so this turn used the standard "
                                         "backend (no spoken approvals). Start it with ./start-gateway.sh")
        collected = []
        for ev in run_hermes(message, session_id, system):
            if ev.get("t") == "delta":
                collected.append(ev.get("text") or "")
            elif ev.get("t") == "complete" and cacheable:
                final_text = ev.get("text") or "".join(collected)
                if final_text:
                    cache_set(message, final_text, ev.get("session_id") or session_id)
            yield ev
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Hermes core: {e}")
