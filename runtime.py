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
import random
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$")

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
# Provider override from the settings picker (JARVIS_PROVIDER). When set, the CLI is
# invoked with `--provider`; when empty, Hermes falls back to config.yaml's model.provider.
PROVIDER = os.environ.get("JARVIS_PROVIDER", "").strip()
PROFILE = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default")).strip() or "default"
# Hermes' gateway only accepts a fixed set of creation surfaces for `hermes chat --source`
# (cli, tui, gui, acp, tool, oneshot). An unlisted label — e.g. the old "jarvis-dashboard" — is
# refused at session.create with "Gateway does not support source ...". "tool" is the documented
# label for third-party integrations driving the CLI: it hides the session from the human CLI/TUI
# pickers and resolves to the same "cli" toolset surface, so nothing else changes.
_SUPPORTED_SOURCES = {"cli", "tui", "gui", "desktop", "acp", "tool", "oneshot"}
SOURCE = os.environ.get("HERMES_SOURCE", "tool").strip() or "tool"
if SOURCE not in _SUPPORTED_SOURCES:
    SOURCE = "tool"
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
PERMISSION = os.environ.get("JARVIS_PERMISSION", os.environ.get("HERMES_PERMISSION", "normal")).strip().lower()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()  # auto|hermes|mock
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "120"))
# Raw transcripts can contain private prompts. Logging is off by default.
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "").strip()
TOOLSETS = os.environ.get("HERMES_TOOLSETS", "").strip()
# Backend (see api_backend.py):
#   auto  (default) use the Hermes API server when it answers ("Hermes kept warm": no new
#         process per turn, spoken approvals), else the one-shot CLI, silently
#   api   same, but say so on every turn that has to fall back to the CLI
#   cli   always the one-shot CLI
BACKEND = os.environ.get("JARVIS_BACKEND", "auto").strip().lower()
API_URL = os.environ.get("JARVIS_API_URL", "http://127.0.0.1:8642").strip().rstrip("/")
API_KEY = os.environ.get("JARVIS_API_KEY", "").strip()
# Start `hermes gateway run` ourselves when nothing answers at API_URL (auto/api only).
START_GATEWAY = os.environ.get("JARVIS_START_GATEWAY", "1").strip() != "0"


def apply_settings(settings):
    """Apply UI-supplied settings to the runtime globals (no restart needed)."""
    global PERMISSION, IDLE_TIMEOUT, WORKDIR, MODEL, PROVIDER
    if settings.get("permission"):
        PERMISSION = str(settings["permission"]).strip().lower()
    if settings.get("timeout"):
        try:
            IDLE_TIMEOUT = int(settings["timeout"])
        except (TypeError, ValueError):
            pass
    if settings.get("workdir"):
        WORKDIR = os.path.expanduser(str(settings["workdir"]).strip())
    # Provider/model chosen in the settings picker. Empty means "leave Hermes' own
    # default in place"; a value rides into every `hermes chat` as --provider/--model.
    # A saved value identical to the profile config is NOT an override: it must not
    # pin the old value and shadow a later change made on the Hermes side.
    native_provider, native_name = _native_model_config()
    if "model_name" in settings:
        chosen = str(settings.get("model_name") or "").strip()
        MODEL = chosen if chosen and chosen != native_name else ""
    if "model_provider" in settings:
        chosen = str(settings.get("model_provider") or "").strip()
        PROVIDER = chosen if chosen and not _same_provider(chosen, native_provider) else ""
    # Nothing to invalidate here: model_info() reads config.yaml directly, and the
    # version/tools probes do not depend on these settings. Clearing the cache made the
    # turn right after every settings save pay for both probes again.


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
    # Deliberately uncached: it only reads config.yaml, and the orb's "live" model line
    # must show a Hermes-side change at once rather than an hour later.
    return _model_info_raw()


def _same_provider(a, b):
    """Compare provider ids, treating the local alias ``local`` as ``llamacpp``."""
    return _canonical_provider(a).lower() == _canonical_provider(b).lower()


def _native_model_config():
    """(provider, model) as the Hermes profile's config.yaml declares them."""
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
    return provider, name


def _model_info_raw():
    provider, name = _native_model_config()
    # The live value Hermes itself is configured with. A saved dashboard choice is
    # an override ONLY when it actually differs from this — a stored value that
    # matches the profile config must never shadow a later Hermes-side change.
    prov_override = bool(PROVIDER) and not _same_provider(PROVIDER, provider)
    name_override = bool(MODEL) and MODEL != name
    eff_provider = PROVIDER if prov_override else (provider or "Hermes default")
    eff_name = MODEL if name_override else (name or "Hermes default")
    return {
        "model_provider": eff_provider or "Hermes default",
        "model_name": eff_name or "Hermes default",
        "model_provider_native": provider or "Hermes default",
        "model_name_native": name or "Hermes default",
        "model_override": bool(prov_override or name_override),
    }


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


# The active foreground process handle lets the browser Escape key stop the backend
# work, not just the frontend fetch. server.RUN_LOCK keeps it to one turn at a time.
_ACTIVE_PROC = None
_ACTIVE_LOCK = threading.Lock()
# Set by cancel_active(). The error that follows a user stop is a cancel, not a
# broken session, so the caller must keep the conversation.
_CANCELLED = threading.Event()

# Runtime probes (`hermes --version`, `hermes tools list`) are subprocess spawns
# that can each take tens of seconds; cache them briefly so every request does
# not re-pay that cost.
_TTL_CACHE = {}
_TTL_LOCK = threading.Lock()
_PROBE_TTL = float(os.environ.get("JARVIS_PROBE_TTL", "3600"))   # warmed at boot; restart after changing Hermes tools

_ABBREVS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
    "e.g", "i.e", "fig", "no", "vol", "inc", "ltd", "co", "corp",
}
_FILE_STEMS = {
    "runtime", "commands", "voice", "server", "brain", "team", "handoff",
    "app", "index", "styles", "themes", "config", "state", "www", "http", "https",
}

# Said only if the answer is slow to start (the UI waits ~1.2s before speaking it).
ACKS = ("On it.", "One moment.", "Give me a second.")


_MD_LINK = re.compile(r"\[([^\]]+)\]\((?:[^)\s]+)\)")
_URL = re.compile(r"\b(?:https?://|www\.)[^\s)]*[^\s).,;:!?]")   # keeps trailing punctuation
_PATH = re.compile(r"(?<![\w/])(?:~/|\.{1,2}/|/)?(?:[\w.-]+/){2,}([\w-]*[A-Za-z][\w.-]*)|(?<![\w/])(?:~/|\./|/)(?:[\w.-]+/)*([\w.-]+)")
_LIST_MARK = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")


def speakable(text):
    """What a sentence sounds like out loud: link text instead of URLs, a file name
    instead of a path, no list markers or table rows. The screen keeps the original."""
    if _TABLE_ROW.match(text):
        return ""
    text = _MD_LINK.sub(r"\1", text)
    text = _URL.sub("the link", text)
    text = _PATH.sub(lambda m: m.group(1) or m.group(2), text)
    text = _LIST_MARK.sub("", text)
    return text.strip()


class SentenceBuffer:
    """Incremental sentence splitter for token-streamed model output.

    Emits only speakable sentences: lines inside ``` code fences are dropped and
    links, URLs and paths are turned into words (see speakable)."""

    def __init__(self):
        self.buf = ""
        self.index = 0
        self.in_fence = False
        self.screen_only = False     # after a `---` line: shown on screen, never spoken

    def _keep(self, raw):
        """Return (index, spoken) for a raw sentence, or None if nothing should be said."""
        if self.screen_only:
            return None
        if raw.strip() == "---":
            self.screen_only = True
            return None
        if raw.lstrip().startswith("```"):
            self.in_fence = not self.in_fence
            return None
        if self.in_fence:
            return None
        spoken = speakable(raw)
        if not spoken:
            return None
        self.index += 1
        return (self.index - 1, spoken)

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
            kept = self._keep(sent) if sent else None
            if kept:
                out.append(kept)

        # A long sentence with no full stop yet: speak up to the last comma so the
        # first audio doesn't wait for the whole sentence.
        if len(self.buf) > 140 and not self.in_fence and not self.buf.lstrip().startswith("```"):
            cut = self.buf.rfind(", ", 60)
            if cut != -1:
                kept = self._keep(self.buf[:cut + 1].strip())
                self.buf = self.buf[cut + 2:]
                if kept:
                    out.append(kept)

        # Also check if buffer ends cleanly at a sentence-closing punctuation
        # (e.g., when a single delta event contains a full sentence without trailing space).
        stripped = self.buf.strip()
        m_end = re.search(r'([A-Za-z]{2,})([.!?]+["\')\]]?)$', stripped)
        if m_end and len(stripped) >= 4:
            punct = m_end.group(2)
            prefix = stripped[:m_end.start(2)]
            if not self._is_false_period(prefix, punct) and not self.in_fence:
                self.buf = ""
                kept = self._keep(stripped)
                if kept:
                    out.append(kept)
        return out

    def flush(self):
        """Flush any remaining trailing text at stream completion."""
        rem = self.buf.strip()
        self.buf = ""
        kept = self._keep(rem) if rem else None
        return [kept] if kept else []


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


def clear_cache():
    """Clear the runtime probe cache."""
    with _TTL_LOCK:
        _TTL_CACHE.clear()


def probe_cache_status():
    """Return warm status and remaining TTL (seconds) for runtime probes."""
    now = time.monotonic()
    keys = {
        "hermes_version": "hermes_version",
        "tools_snapshot": "tools_snapshot",
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
    """Pre-warm `hermes --version`, `hermes tools list`, and user_name caches."""
    def _warm():
        runtime_kind()
        hermes_tools_snapshot()
        user_name()
        return probe_cache_status()

    if background:
        t = threading.Thread(target=_warm, daemon=True)
        t.start()
        return probe_cache_status()
    return _warm()


_HEALTH = {"at": -1e9, "ok": False}


def api_backend_ready():
    """Is the Hermes API server up? Cached for a few seconds: /api/status and every
    turn ask, and a down server costs a 1.5s timeout each time."""
    if BACKEND not in ("api", "auto"):
        return False
    now = time.monotonic()
    if now - _HEALTH["at"] > 5:
        import api_backend
        _HEALTH.update(at=now, ok=api_backend.healthy(API_URL))
    return _HEALTH["ok"]


# ── keep Hermes warm: our own gateway child when none is running ────────────────
_GATEWAY = {"proc": None, "state": "off", "note": ""}
_GATEWAY_LOG = pathlib.Path(__file__).resolve().parent / "logs" / "gateway.log"


def _append_env(path, key, value):
    """Set KEY=value in the dashboard's private .env (created 0600 if missing).

    An existing EMPTY assignment is replaced rather than joined by a duplicate: the
    loader treats `KEY=` as unset, and a duplicate would leave the empty assignment
    first in the file, so the real value could never win.
    """
    path = pathlib.Path(path)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    out, replaced, present = [], False, False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(f"{key}=") or stripped.startswith(f"export {key}="):
            if not replaced and stripped in (f"{key}=", f"export {key}="):
                out.append(f"{key}={value}")          # an empty assignment is "unset": fill it
                replaced = True
            else:
                present = True                        # a real value already wins the load
                out.append(line)
        else:
            out.append(line)
    if not replaced and not present:
        out += ["", "# Hermes API server key (created by the dashboard)", f"{key}={value}"]
    # Write a private temp file and swap it in: truncating .env in place would lose every
    # key in it if the write were cut short.
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def gateway_status():
    """(state, note): off | external | starting | ours | failed | slow."""
    return _GATEWAY["state"], _GATEWAY["note"]


def start_gateway(env_file):
    """Keep Hermes warm. When the API backend is wanted and nothing answers at API_URL,
    run `hermes gateway run` with its API server switched on, as our child, and stop
    it when the dashboard stops. Never blocks: turns use the CLI until it is up.

    Note: a gateway also runs Hermes' cron jobs and any messaging bots you set up.
    Hermes itself refuses a second gateway, so this never duplicates one."""
    global API_KEY
    if BACKEND == "cli" or not START_GATEWAY or RUNTIME == "mock":
        return
    from urllib.parse import urlparse
    url = urlparse(API_URL)
    if url.hostname not in ("127.0.0.1", "localhost"):
        _GATEWAY.update(state="external", note=f"using the API server at {API_URL}")
        return
    if not API_KEY:
        API_KEY = __import__("secrets").token_urlsafe(32)
        try:
            _append_env(env_file, "JARVIS_API_KEY", API_KEY)
        except OSError:
            pass                                   # still works for this launch

    def work():
        import api_backend
        if api_backend.healthy(API_URL):
            _GATEWAY.update(state="external", note=f"an API server is already running at {API_URL}")
            return
        env = _child_env(API_SERVER_ENABLED="true", API_SERVER_KEY=API_KEY,
                         API_SERVER_HOST="127.0.0.1",
                         API_SERVER_PORT=str(url.port or 8642))
        try:
            _GATEWAY_LOG.parent.mkdir(parents=True, exist_ok=True)
            log = open(_GATEWAY_LOG, "ab")
            proc = subprocess.Popen(_hermes_base() + ["gateway", "run"], cwd=WORKDIR, env=env,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            log.close()                            # the child keeps its own handle
        except OSError as e:
            _GATEWAY.update(state="failed", note=f"could not start the Hermes gateway: {e}")
            return
        _GATEWAY.update(proc=proc, state="starting", note="Hermes gateway starting")
        deadline = time.monotonic() + 90           # MCP servers and tools load first
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                _GATEWAY.update(proc=None, state="failed", note=(
                    "the Hermes gateway would not start (often: a gateway service is already "
                    "running without its API server). Using the CLI. See logs/gateway.log"))
                return
            if api_backend.healthy(API_URL, timeout=1):
                _HEALTH.update(at=-1e9)            # use it from the next turn
                _GATEWAY.update(state="ours", note=f"Hermes kept warm (gateway pid {proc.pid})")
                return
            time.sleep(0.5)
        _GATEWAY.update(state="slow", note="Hermes gateway still starting; using the CLI until it answers")

    threading.Thread(target=work, daemon=True).start()


def stop_gateway():
    """Stop the gateway we started (never one we found running)."""
    proc = _GATEWAY["proc"]
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=15)                     # let it finish a turn and save sessions
    except subprocess.TimeoutExpired:
        proc.kill()
    _GATEWAY.update(proc=None, state="off", note="")


def resolve_approval(run_id, request_id, choice):
    import api_backend
    return api_backend.resolve_approval(API_URL, API_KEY, run_id, request_id, choice)


def cancel_active():
    """Terminate the currently running Hermes child process, if any."""
    _CANCELLED.set()
    if BACKEND != "cli":
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
    if not ok:                      # never cache a failure: retry as soon as Hermes is fixed
        with _TTL_LOCK:
            _TTL_CACHE.pop("hermes_version", None)
    return "hermes" if ok else "mock"


_ANSWER_RULE = ("Answer the request now. Start with the words ATLAS should say aloud; never include "
                "session IDs, runtime metadata, or process narration. If on-screen detail helps, put it "
                "after a line containing only --- (that part is shown, not spoken).")


def build_prompt(message, system=None):
    # Hermes chat has no separate --system flag (verified v0.22.2), so the voice
    # persona and the request are combined into one explicit turn. This stops the
    # model answering as a coding agent that narrates its own machinery.
    if not system:
        return message
    return f"{system}\n\n## Current user request\n{message}\n\n{_ANSWER_RULE}"


def build_instructions(system=None):
    """API backend: the persona travels as per-turn `instructions` (Hermes' ephemeral
    system prompt), so the saved conversation holds only what you actually said."""
    return f"{system}\n\n{_ANSWER_RULE}" if system else None


def _child_env(**extra):
    """The environment every Hermes child inherits: our own environment, the profile
    propagated (profile selection is env-based), and the common Homebrew/user bin dirs on
    PATH so a GUI-started shell can still find `hermes`. One builder, so the chat, the
    model test and the gateway can never drift apart."""
    env = dict(os.environ)
    env["HERMES_PROFILE"] = PROFILE
    home = os.path.expanduser("~")
    env["PATH"] = ":".join(dict.fromkeys([
        env.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin",
        os.path.join(home, ".local", "bin"), os.path.join(home, ".npm-global", "bin"),
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ]))
    env.update(extra)
    return env


def _model_flags(model, provider):
    """`--model`/`--provider` for a chat invocation, each only when actually set."""
    flags = []
    if model:
        flags += ["--model", model]
    if provider:
        flags += ["--provider", provider]
    return flags


def build_command(message, session_id=None):
    # --format stream-json = structured NDJSON on stdout (implies --quiet).
    # --query-file - reads the prompt from stdin, the documented-safe way to pass
    # arbitrary text (nothing is shell-interpreted, no argv length limits).
    cmd = _hermes_base() + ["chat", "--format", "stream-json", "--query-file", "-",
                            "--source", SOURCE]
    if valid_session(session_id):
        cmd += ["--resume", str(session_id)]
    cmd += _model_flags(MODEL, PROVIDER)
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


# ── provider + model discovery (for the settings picker) ─────────────────────
# The picker must offer the models Hermes can genuinely use, so the list is
# discovered from the Hermes runtime instead of being hardcoded here. No file in
# hermes_cli/ is stable enough to depend on; instead we run the CLI's own Python
# API (`hermes_cli.models.list_available_providers` / `curated_models_for_provider`)
# in its own interpreter, exactly as `hermes model` does. When the install or the
# interpreter cannot be found — or the call fails — we return an empty list and a
# reason rather than inventing names.
_MODELS_PROBE_MARK = "__JARVIS_MODELS__"
_MODELS_PROBE_SRC = r'''
import json, os, sys

root, home, provider = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")
out = {"ok": False, "providers": [], "models": [], "error": ""}
try:
    if home:
        os.environ["HERMES_HOME"] = home
    sys.path.insert(0, root)
    import hermes_bootstrap  # noqa: F401  (sets up the Hermes dependency graph)
    from hermes_cli import models as M
    out["providers"] = [
        {"id": p.get("id"), "label": p.get("label") or p.get("id"),
         "authenticated": bool(p.get("authenticated"))}
        for p in M.list_available_providers()
    ]
    if provider:
        out["models"] = [m[0] for m in M.curated_models_for_provider(provider)]
    out["ok"] = True
except Exception as e:  # noqa: BLE001
    out["error"] = "%s: %s" % (type(e).__name__, e)
print("__JARVIS_MODELS__" + json.dumps(out))
'''
_MODELS_TTL = float(os.environ.get("JARVIS_MODELS_TTL", "300"))
_MODELS_TIMEOUT = float(os.environ.get("JARVIS_MODELS_TIMEOUT", "30"))


def _hermes_home_base():
    """The Hermes install root (~/.hermes), independent of the selected profile."""
    return pathlib.Path(os.path.expanduser(os.environ.get("HERMES_HOME") or "~/.hermes"))


def _hermes_agent_root():
    """The checkout that holds ``hermes_cli/`` — the import root the CLI uses."""
    seen = []
    for base in (_hermes_home_base(), pathlib.Path(os.path.expanduser("~/.hermes"))):
        if base in seen:
            continue
        seen.append(base)
        cand = base / "hermes-agent"
        if (cand / "hermes_cli").is_dir():
            return cand
    return None


def _hermes_store_python():
    """The store interpreter that runs Hermes (``<home>/tools/python-*/bin/python3``)."""
    seen = []
    for base in (_hermes_home_base(), pathlib.Path(os.path.expanduser("~/.hermes"))):
        if base in seen:
            continue
        seen.append(base)
        tools = base / "tools"
        if tools.is_dir():
            found = sorted(tools.glob("python-*/bin/python3"))
            if found:
                return found[-1]
    return None


def _discover_models(provider=""):
    key = ("models_discovery", str(_profile_home()), str(provider))
    return _ttl_cached(key, _MODELS_TTL, _discover_models_raw, provider)


def _discover_models_raw(provider=""):
    py = _hermes_store_python()
    root = _hermes_agent_root()
    if not py or not root:
        return {"ok": False, "providers": [], "models": [],
                "error": "Hermes install (hermes-agent + its bundled Python) was not found, "
                         "so the model list is unavailable."}
    path = None
    try:
        fd, path = tempfile.mkstemp(prefix="jarvis-models-", suffix=".py")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(_MODELS_PROBE_SRC)
        env = dict(os.environ)
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        proc = subprocess.run(
            [str(py), "-I", path, str(root), str(_profile_home()), str(provider or "")],
            cwd=str(root), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, timeout=_MODELS_TIMEOUT)
        payload = None
        for line in (proc.stdout or "").splitlines():
            if line.startswith(_MODELS_PROBE_MARK):
                try:
                    payload = json.loads(line[len(_MODELS_PROBE_MARK):])
                except ValueError:
                    payload = None
        if payload is None:
            tail = [ln for ln in (proc.stderr or "").strip().splitlines() if ln.strip()]
            detail = tail[-1][:200] if tail else "the Hermes runtime produced no output."
            return {"ok": False, "providers": [], "models": [],
                    "error": f"Model discovery failed: {detail}"}
        return payload
    except subprocess.TimeoutExpired:
        return {"ok": False, "providers": [], "models": [],
                "error": f"Model discovery timed out after {int(_MODELS_TIMEOUT)}s."}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "providers": [], "models": [],
                "error": f"Model discovery failed: {str(e)[:200]}"}
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


_LOCAL_TTL = float(os.environ.get("JARVIS_LOCAL_TTL", "15"))
_LOCAL_ALIASES = {"local": "llamacpp", "llama.cpp": "llamacpp", "llama-cpp": "llamacpp"}


def _canonical_provider(pid):
    """Map the local alias ``local`` (and spellings) to the canonical ``llamacpp``."""
    return _LOCAL_ALIASES.get(str(pid or "").strip().lower(), str(pid or "").strip())


def _local_alias_model():
    """``model_aliases.local.model`` from the profile config, or ``""``."""
    try:
        text = (_profile_home() / "config.yaml").read_text(encoding="utf-8")
    except OSError:
        return ""
    block = re.search(r"^model_aliases:[ \t]*\n((?:[ \t]+.*\n?)*)", text, re.M)
    if not block:
        return ""
    sub = re.search(r"^[ \t]+local:[ \t]*\n((?:[ \t]{4,}.*\n?)*)", block.group(1), re.M)
    if sub:
        m = re.search(r"^[ \t]+model:[ \t]*(\S+)", sub.group(1), re.M)
        if m:
            return m.group(1).strip("'\"")
    return ""


def _local_llamacpp_raw():
    """Describe the Hermes-managed local llama.cpp runtime (provider ``llamacpp``).

    Reads ``~/.hermes/runtimes/llamacpp/server.json`` for the live base URL and API
    key, probes ``/health`` so a stopped server is reported honestly, then lists
    ``/v1/models``. Nothing is invented: a down server yields ``reachable`` false and
    an empty model list with a reason."""
    path = _hermes_home_base() / "runtimes" / "llamacpp" / "server.json"
    out = {"id": "llamacpp", "label": "Local · llama.cpp", "aliases": ["local"],
           "local": True, "reachable": False, "base_url": "", "models": [], "reason": ""}
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        out["reason"] = "No managed llama.cpp server is configured."
        return out
    base = str(cfg.get("base_url") or "").strip().rstrip("/")
    key = str(cfg.get("api_key") or "").strip()
    out["base_url"] = base
    if not base:
        out["reason"] = "The managed llama.cpp server has no base URL."
        return out
    root = base[:-3] if base.endswith("/v1") else base
    try:
        with urllib.request.urlopen(root + "/health", timeout=3) as r:
            out["reachable"] = 200 <= int(getattr(r, "status", 200)) < 300
    except (urllib.error.URLError, OSError, ValueError):
        out["reachable"] = False
    if not out["reachable"]:
        out["reason"] = "The local llama.cpp server is not running."
        return out
    try:
        req = urllib.request.Request(base + "/models")
        if key:
            req.add_header("Authorization", "Bearer " + key)
        with urllib.request.urlopen(req, timeout=6) as r:
            payload = json.loads(r.read().decode("utf-8") or "{}")
        out["models"] = [str(m.get("id")) for m in (payload.get("data") or [])
                         if isinstance(m, dict) and m.get("id")]
    except (urllib.error.URLError, OSError, ValueError):
        out["reason"] = "Local server is reachable, but its model list could not be read."
    if not out["models"]:
        alias = _local_alias_model()
        if alias:
            out["models"] = [alias]
            out["reason"] = ""
    return out


def _local_llamacpp():
    return _ttl_cached(("local_llamacpp", str(_hermes_home_base())), _LOCAL_TTL, _local_llamacpp_raw)


def models_catalog(provider=None):
    """Providers plus the models available for ``provider`` (defaults to the active one).

    Shape: {ok, provider, providers:[{id,label,authenticated,aliases,local,reachable}],
    models:[id], reason, source}. The managed local llama.cpp runtime is merged in as
    the ``llamacpp`` provider (alias ``local``) even though the Hermes CLI catalog does
    not enumerate it. ``models`` is empty with a human-readable ``reason`` whenever a
    list could not be produced — never a fabricated one."""
    info = model_info()
    raw_target = str(provider or PROVIDER or info.get("model_provider") or "").strip()
    if raw_target in ("", "Hermes default"):
        raw_target = ""
    target = _canonical_provider(raw_target)
    local = _local_llamacpp()
    # Discovery is provider-scoped; for the local runtime the CLI has no entry, so
    # only the provider list is needed from it.
    found = _discover_models("" if target == "llamacpp" else target)

    providers, seen = [], set()
    for p in (found.get("providers") or []):
        pid = str(p.get("id") or "").strip()
        if not pid or pid in seen:      # the Hermes catalog can repeat e.g. "custom"
            continue
        seen.add(pid)
        providers.append({"id": pid, "label": p.get("label") or pid,
                          "authenticated": bool(p.get("authenticated")),
                          "aliases": list(p.get("aliases") or []),
                          "local": False, "reachable": None})
    local_entry = {"id": local["id"], "label": local["label"],
                   "authenticated": bool(local["reachable"]),
                   "aliases": list(local.get("aliases") or ["local"]),
                   "local": True, "reachable": bool(local["reachable"]),
                   "base_url": local.get("base_url") or ""}
    existing = next((p for p in providers if p["id"] == local["id"]), None)
    if existing:
        existing.update(local_entry)
    else:
        providers.insert(0, local_entry)

    tgt = next((p for p in providers if p.get("id") == target), None)
    if target == "llamacpp":
        models = [str(m) for m in (local.get("models") or [])]
        ok = True
        reason = "" if models else (local.get("reason") or
                                    "The local llama.cpp server has no models available.")
    else:
        models = [str(m) for m in (found.get("models") or [])]
        ok = bool(found.get("ok"))
        reason = ""
        if not ok:
            reason = found.get("error") or "Model discovery is unavailable."
        elif not target:
            reason = "No provider is configured yet."
        elif not models:
            if tgt and not tgt.get("authenticated"):
                reason = (f"No credentials available for {tgt.get('label') or target}. "
                          "Sign in with `hermes model`.")
            else:
                reason = f"No models discovered for {target}. Run `hermes model` to refresh the catalog."
    return {
        "ok": bool(ok),
        "provider": ({"id": target, "label": (tgt or {}).get("label") or target,
                      "authenticated": bool((tgt or {}).get("authenticated")),
                      "local": bool((tgt or {}).get("local")),
                      "reachable": (tgt or {}).get("reachable"),
                      "aliases": list((tgt or {}).get("aliases") or [])} if target else None),
        "providers": providers,
        "models": models,
        "reason": reason,
        "source": "local-runtime" if target == "llamacpp" else
                  ("hermes-cli" if found.get("ok") else "unavailable"),
    }


def test_model(provider=None, model=None):
    """Fire one trivial prompt through Hermes with the candidate provider/model and
    report the round-trip. Nothing is persisted: this only validates the choice."""
    provider = str(provider or "").strip()
    model = str(model or "").strip()
    cmd = _hermes_base() + ["chat", "--format", "stream-json", "--query-file", "-", "--source", SOURCE]
    cmd += _model_flags(model, provider)     # the one place model/provider flags are built
    if PERMISSION == "bypass":
        cmd += ["--yolo"]
    child_env = _child_env()
    started = time.monotonic()
    try:
        proc = subprocess.run(cmd, cwd=WORKDIR, input="Reply with the single word: pong",
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=child_env, timeout=float(os.environ.get("JARVIS_TEST_TIMEOUT", "120")))
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "The test prompt timed out before the model answered."}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"Could not launch Hermes: {str(e)[:200]}"}
    reply, result, exit_code = "", None, None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "text":
            reply += ev.get("text") or ""
        elif ev.get("type") == "result":
            result = ev
            exit_code = ev.get("exit_code")
            reply = ev.get("text") or reply
    ms = int((time.monotonic() - started) * 1000)
    if result is None or (exit_code not in (None, 0)):
        detail = ""
        if result is not None:
            detail = str(result.get("error") or result.get("text") or "")
        if not detail:
            tail = [ln for ln in (proc.stderr or "").strip().splitlines() if ln.strip()]
            detail = tail[-1] if tail else "no answer came back"
        return {"ok": False, "error": detail[:300], "ms": ms}
    reply = reply.strip()
    if not reply:
        return {"ok": False, "error": "The model returned an empty answer.", "ms": ms}
    return {"ok": True, "reply": reply[:400], "ms": ms}


def run_hermes(message, session_id=None, system=None):
    global _ACTIVE_PROC
    started = _mono_ms()
    cmd = build_command(message, session_id)
    prompt = build_prompt(message, system)
    yield dict(t="status", model=MODEL or "Hermes default",
               mcp=[], permission=PERMISSION, profile=PROFILE, runtime="hermes",
               session_id=session_id)

    child_env = _child_env()

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
        except Exception:
            pass                     # pipe closed under us; the main loop reports the exit
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
                # A tool may legitimately run silent for a while, but a hung one must not
                # hold the turn (and every message after it) forever.
                limit = IDLE_TIMEOUT * (10 if in_tool else 1)
                if time.monotonic() - last > limit:
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except Exception:
                        pass
                    err = " | ".join(list(errbuf)[-3:])
                    yield dict(t="error", message=(f"Hermes went quiet for {limit}s and was stopped. " + err)[:400])
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
                # The answer is in. Give Hermes a moment to exit, but a slow shutdown
                # (MCP servers, saving memory) is not an error: it is reaped below.
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                return

        try:
            rc = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            rc = -1
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
        if completed and proc.poll() is None:
            # Answer delivered and Hermes is still shutting down: never kill it mid-save.
            # The pump threads keep draining its pipes; reap it in the background.
            def _reap(p=proc):
                p.wait()
                for s in (p.stdout, p.stderr):
                    try:
                        s.close()
                    except Exception:
                        pass
            threading.Thread(target=_reap, daemon=True).start()
        else:
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
    """One foreground turn. An error caused by the user pressing stop is reported as
    `cancelled` instead, so the caller keeps the conversation."""
    _CANCELLED.clear()
    for ev in _run(message, session_id, system):
        if ev.get("t") == "error" and _CANCELLED.is_set():
            yield dict(t="cancelled", message="stopped")
            return
        yield ev


def _run(message, session_id=None, system=None):
    # Acknowledgement first; the UI only speaks it if no sentence arrives quickly.
    yield dict(t="ack", text=random.choice(ACKS), ms=0)

    if runtime_kind() != "hermes":
        yield from run_mock(message, session_id, system)
        return
    try:
        if BACKEND in ("api", "auto"):
            if api_backend_ready():
                import api_backend
                sbuf = SentenceBuffer()
                started = _mono_ms()
                for ev in api_backend.run(
                    message, session_id, build_instructions(system),
                    base=API_URL, key=API_KEY, idle_timeout=IDLE_TIMEOUT,
                    valid_session=valid_session, mono_ms=_mono_ms,
                    profile=PROFILE, permission=PERMISSION,
                    auto_approve=(PERMISSION == "bypass"),
                    model=MODEL, provider=PROVIDER,
                ):
                    if ev.get("t") == "delta":
                        chunk = ev.get("text") or ""
                        yield ev
                        for s_idx, sent in sbuf.feed(chunk):
                            yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
                    elif ev.get("t") == "complete":
                        for s_idx, sent in sbuf.flush():
                            yield dict(t="sentence", text=sent, index=s_idx, ms=_mono_ms() - started)
                        yield ev
                    else:
                        yield ev
                return
            if BACKEND == "api":
                yield dict(t="note", message="Hermes API server isn't reachable, so this turn used the standard "
                                             "backend (no spoken approvals). " + (_GATEWAY["note"] or ""))
        yield from run_hermes(message, session_id, system)
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Hermes core: {e}")
