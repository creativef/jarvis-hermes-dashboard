"""
JARVIS Live — a HUD that drives Hermes Agent.

    python3 server.py

The brain is your own Hermes Agent CLI/profile. Hermes keeps access to the same
configured tools, browser/Chrome automation, MCP servers, skills, memory, and
third-party integrations that your normal Hermes sessions have. Voice can use the
local Parakeet (speech in) and Kokoro (speech out), with macOS `say` and browser
speech as fallbacks.
"""
import json
import logging
import mimetypes
import os
import pathlib
import re
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from urllib.parse import parse_qs, urlparse

ROOT = pathlib.Path(__file__).resolve().parent
UI = ROOT / "ui"

# load .env before importing anything that reads os.environ
def _load_dotenv(path):
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # strip a trailing inline comment only when the '#' is preceded by
        # whitespace, so a '#' inside a value is preserved
        hash_idx = value.find(" #")
        if hash_idx != -1:
            value = value[:hash_idx].rstrip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if not value:
            continue              # `KEY=` means unset — it must never shadow a real value
        os.environ.setdefault(key, value)


_env = ROOT / ".env"
if _env.exists():
    _load_dotenv(_env)

import commands         # noqa: E402
import brain            # noqa: E402
import brief            # noqa: E402
import runtime          # noqa: E402
import voice            # noqa: E402
import phrases          # noqa: E402

# Apply any UI-persisted settings (stored in state.json) over the env defaults.
runtime.apply_settings(commands.get_settings())
voice.apply_settings(commands.get_settings())

PORT = int(os.environ.get("JARVIS_PORT", "8730"))
# A self-restart (see _maybe_restart) hands its token and boot id to the new process, so the
# open tab keeps working: no 401 -> reload, no wiped screen, no second "good evening".
# Popped so they never leak into the environment of Hermes or helper children.
API_TOKEN = os.environ.pop("JARVIS_TOKEN", "") or secrets.token_urlsafe(32)
BOOT_ID = os.environ.pop("JARVIS_BOOT_ID", "") or secrets.token_hex(4)   # drives "greet once per launch"
RUN_LOCK = threading.Lock()
MAX_JSON_BODY = 1024 * 1024
MAX_INBOX_BODY = 14 * 1024 * 1024
MAX_AUDIO_BODY = 12 * 1024 * 1024
# Chat-composer attachments arrive as raw bytes and are streamed straight to disk in
# chunks, so a big file never sits in memory (base64-in-JSON would have cost ~2.5x).
MAX_ATTACH_BYTES = 200 * 1024 * 1024
_ATTACH_CHUNK = 1024 * 1024
# Day folders older than this are pruned: nothing else ever deletes from the drop area.
ATTACH_KEEP_DAYS = 30
# Where composer attachments land. Deliberately NOT ~/Atlas: this is the chat
# drop area, it never touches the inbox or the Brain.
ATTACH_ROOT = ROOT / "attachments"

# Durable rotating error log. The UI action log is in-memory (capped) and
# JARVIS_VERBOSE only prints access lines, so failures at rest need a file.
LOG_DIR = ROOT / "logs"
_ERR_LOG = None


def _setup_error_log():
    global _ERR_LOG
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / "server.log"
        path.touch(exist_ok=True)
        os.chmod(path, 0o600)
        handler = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger = logging.getLogger("jarvis")
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        _ERR_LOG = logger
    except OSError:
        _ERR_LOG = None

# ── safe restart ─────────────────────────────────────────────
# Atlas edits this dashboard's own code. Killing the server to reload it cut Atlas off
# mid-reply, the tab reloaded into a blank screen and a fresh greeting, and the killed voice
# worker meant the next words came in the fallback voice. tools/restart-dashboard.sh only
# drops this flag; the server restarts itself between turns, once it has stopped talking.
RESTART_FLAG = LOG_DIR / "restart-requested"
RESTART_QUIET_S = 5                    # no speech/listen request for this long first
_VOICE_AT = [0.0]                      # monotonic time of the last /api/speak or /api/listen


def _maybe_restart():
    """Re-exec this server when a restart was requested and nothing is in flight.
    Same token and boot id, so the open tab carries on. Returns False when not yet."""
    if not RESTART_FLAG.exists() or time.monotonic() - _VOICE_AT[0] < RESTART_QUIET_S:
        return False
    if not RUN_LOCK.acquire(blocking=False):           # a turn is still streaming
        return False
    handover = voice.handover_env()                    # keep the loaded voice: no second voice
    if handover is None:                               # a line is being synthesised right now
        RUN_LOCK.release()
        return False
    try:
        RESTART_FLAG.unlink(missing_ok=True)
    except OSError:
        pass
    print("  restarting (requested)…", flush=True)
    env = dict(os.environ, JARVIS_TOKEN=API_TOKEN, JARVIS_BOOT_ID=BOOT_ID, JARVIS_OPEN="0", **handover)
    try:
        os.execve(sys.executable, [sys.executable, str(ROOT / "server.py")], env)
    except OSError:
        voice.handover_cancelled()
        RUN_LOCK.release()
        raise
    return True                                        # only reached when execve is mocked


def _restart_watcher():
    while True:
        time.sleep(1)
        try:
            _maybe_restart()
        except OSError as e:
            if _ERR_LOG:
                _ERR_LOG.error("restart failed: %s", e)


# The Jarvis persona, appended to every run. Without it, the model answers as a
# coding agent and narrates its own tooling — which is not what you want spoken
# out loud. Edit persona.md to change how it talks.
_PERSONA_FILE = ROOT / "persona.md"


def persona():
    try:
        base = _PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        base = ""
    name = commands.get_settings().get("user_name", "").strip() or runtime.user_name()
    who = (f"## Who you serve\nYou serve {name}. "
           "Address them by name, naturally.")
    extra = commands.context_block()      # profile / goal / personality / queue
    never = phrases.never_say_block()   # stable unless phrases.json changes: keeps the prompt cache
    return "\n\n".join(x for x in (base, who, extra, never) if x)
# One continuing Hermes conversation until the user hits /new. Persisted across
# restarts so the assistant remembers the prior conversation.
SESSION = {"id": commands.get_session()}
# Consecutive failed turns. A single flaky turn (a 429, a provider timeout, a 120s idle
# stop) must not cost you the thread; two in a row means the session itself is bad.
ERROR_STREAK = {"n": 0}


def _drop_session():
    """Forget the Hermes conversation everywhere: in memory, in state.json (or a restart
    would resume it), and the error streak that counted towards dropping it."""
    SESSION["id"] = None
    commands.set_session(None)
    ERROR_STREAK["n"] = 0


def _merged_settings():
    """Runtime settings plus the UI-only prefs (greeting name / toggle)."""
    out = dict(runtime.current_settings())
    st = commands.get_settings()
    out["user_name"] = st.get("user_name", "")
    out["greeting"] = st.get("greeting", True)
    out["voice"] = voice.KOKORO_VOICE
    out["voice_speed"] = voice.KOKORO_SPEED
    out["voices"] = list(voice.VOICES)
    return out


def build_greeting(now=None):
    """Short spoken hello. Templated on purpose: no model call, so it is instant and free."""
    import datetime
    now = now or datetime.datetime.now()
    st = commands.get_settings()
    name = st.get("user_name", "").strip()
    h = now.hour
    opener, part = ("Still up", "late") if h < 4 else ("Good morning", "morning") if h < 12 \
        else ("Good afternoon", "afternoon") if h < 18 else ("Good evening", "evening")
    head = f"{opener}, {name}." if name else f"{opener}."
    line = phrases.pick(f"greet_{part}", "Ready when you are.")
    return {"text": f"{head} {line}", "boot_id": BOOT_ID,
            "enabled": bool(st.get("greeting", True))}


def claim_greeting(busy=False, now=None):
    """The day's one chance to greet out loud, decided here so every tab, address and restart
    agrees. True only for the first ask of the day, and only if nothing has happened yet: no
    conversation today, no reply streaming, no helper job running. Any ask uses the day up,
    so a greeting never turns up later, in the middle of the day's work."""
    import datetime
    now = now or datetime.datetime.now()
    if not commands.get_settings().get("greeting", True):
        return False
    today = now.date().isoformat()
    midnight = datetime.datetime.combine(now.date(), datetime.time()).timestamp()
    busy = busy or RUN_LOCK.locked() or bool(commands.running_jobs())

    def claim(d):
        if d.get("greeted_on") == today:
            return False
        d["greeted_on"] = today
        talked = any(float(t.get("ts") or 0) >= midnight for t in d.get("history", [])[-50:])
        return not (busy or talked)
    return commands.update_state(claim)




# ── chat-composer attachments ────────────────────────────────
# Purely local: files land in <project>/attachments/<YYYY-MM-DD>/ and the UI passes
# their absolute paths to the agent in the message text. Nothing here writes to
# ~/Atlas, the inbox, or the Brain.

def _attach_day_dir(day=None):
    import datetime
    return ATTACH_ROOT / (day or datetime.date.today().isoformat())


def _attach_prune():
    """Drop day folders older than ATTACH_KEEP_DAYS. Nothing else ever deletes from the
    composer's drop area, so without this it grows without bound."""
    import datetime
    cutoff = (datetime.date.today() - datetime.timedelta(days=ATTACH_KEEP_DAYS)).isoformat()
    try:
        days = [d for d in ATTACH_ROOT.iterdir() if d.is_dir()]
    except OSError:
        return
    for d in days:
        if d.name >= cutoff:
            continue
        try:
            for f in d.iterdir():
                if f.is_file():
                    f.unlink(missing_ok=True)
            d.rmdir()
        except OSError:
            pass


def _attach_safe_name(raw):
    """Keep the last path segment of an untrusted client name and strip everything
    that could escape the directory, hide the file, or confuse a shell."""
    text = str(raw or "").replace("\\", "/")          # a windows path is not a path here
    text = text.split("/")[-1].replace("\x00", "").strip()
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text)
    text = text.strip("._-")
    if not text:
        return "file"
    stem, dot, ext = text.rpartition(".")
    if dot and stem and 0 < len(ext) <= 8:
        return f"{stem[:80]}.{ext}"
    return text[:80] or "file"


def _attach_mime(name, kind=""):
    guess = mimetypes.guess_type(name)[0]
    if guess:
        return guess
    kind = str(kind or "").strip()
    return kind if "/" in kind and len(kind) <= 100 else "application/octet-stream"


def attach_save(raw_name, stream, length, kind=""):
    """Stream `length` raw bytes from `stream` into a new file under ATTACH_ROOT.
    Returns (info, err). A short read (the upload broke off) leaves no partial file."""
    name = str(raw_name or "").strip() or "file"
    if length <= 0:
        return None, "file is empty"
    if length > MAX_ATTACH_BYTES:
        return None, f"file is larger than {MAX_ATTACH_BYTES // (1024 * 1024)} MB"

    root = ATTACH_ROOT.resolve()
    try:
        target_dir = _attach_day_dir().resolve()
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return None, f"could not create the attachments directory: {e}"
    if os.path.commonpath([target_dir, root]) != str(root):
        return None, "refusing to write outside the attachments directory"

    safe = _attach_safe_name(name)
    stem, dot, ext = safe.rpartition(".")
    if not dot:
        stem, ext = safe, ""
    path = None
    for n in range(1, 201):
        candidate = target_dir / (f"{stem}{'' if n == 1 else f'-{n}'}{('.' + ext) if ext else ''}")
        # commonpath refusal, not a prefix test, so `..`-style names can never pass
        if os.path.commonpath([str(candidate.parent), str(root)]) != str(root):
            return None, "refusing to write outside the attachments directory"
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue                                  # same name today: keep them all
        except OSError as e:
            return None, f"could not write the file: {e}"
        left = length
        try:
            with os.fdopen(fd, "wb") as fh:
                while left:
                    chunk = stream.read(min(_ATTACH_CHUNK, left))
                    if not chunk:
                        break
                    fh.write(chunk)
                    left -= len(chunk)
        except OSError as e:
            left = left or -1
            err = f"could not write the file: {e}"
        else:
            err = "the upload was cut off before the whole file arrived"
        if left:
            candidate.unlink(missing_ok=True)
            return None, err
        path = candidate
        break
    if path is None:
        return None, "could not find a free filename"
    # final check on what actually exists on disk
    if os.path.commonpath([str(path.resolve().parent), str(root)]) != str(root):
        try:
            path.unlink()
        except OSError:
            pass
        return None, "refusing to write outside the attachments directory"
    _attach_prune()                            # one iterdir per upload keeps the drop area bounded
    return {"path": str(path.resolve()), "name": path.name, "bytes": length,
            "mime_guess": _attach_mime(path.name, kind)}, None


def attachments_list(day=None):
    """Read-only inventory of what the composer has stashed (newest first)."""
    items, dirs = [], []
    try:
        day_dirs = [_attach_day_dir(day)] if day else sorted(
            (d for d in ATTACH_ROOT.iterdir() if d.is_dir()), reverse=True)
    except OSError:
        day_dirs = []
    for d in day_dirs:
        if not d.is_dir():
            continue
        dirs.append(str(d))
        for f in sorted(d.iterdir()):
            try:
                if not f.is_file():
                    continue
                st = f.stat()
            except OSError:
                continue
            items.append({"name": f.name, "path": str(f.resolve()), "dir": str(d),
                          "bytes": st.st_size, "mtime": int(st.st_mtime),
                          "mime_guess": mimetypes.guess_type(f.name)[0] or "application/octet-stream"})
    items.sort(key=lambda i: i["mtime"], reverse=True)
    return {"ok": True, "root": str(ATTACH_ROOT), "dirs": dirs,
            "count": len(items), "items": items[:500]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("JARVIS_VERBOSE"):
            sys.stderr.write("  " + (fmt % args) + "\n")

    def log_error(self, format, *args):
        msg = format % args
        if _ERR_LOG:
            _ERR_LOG.error("client=%s %s", self.client_address, msg)
        if os.environ.get("JARVIS_VERBOSE"):
            sys.stderr.write("  ERROR " + msg + "\n")

    # ── helpers ──────────────────────────────────────────────
    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; font-src 'self'; "
                         "img-src 'self' data:; connect-src 'self'; "
                         "media-src 'self' blob:; object-src 'none'; "
                         "base-uri 'self'; form-action 'self'")

    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        if code >= 400:
            # Rejections can happen before the body is read. On a kept-alive connection
            # those unread bytes would be parsed as the next request, so close it.
            self.close_connection = True
            self.send_header("Connection", "close")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def _read(self, limit):
        n = int(self.headers.get("Content-Length", 0))
        if n < 0 or n > limit:
            raise ValueError(f"request body exceeds {limit} bytes")
        return self.rfile.read(n) if n else b""

    @staticmethod
    def _obj(raw):
        """Parse a JSON object body, or None for bad JSON / a non-object."""
        try:
            body = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return body if isinstance(body, dict) else None

    def _host_ok(self):
        host = self.headers.get("Host", "")
        return host in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin in {
            f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"
        }

    def _token_ok(self):
        supplied = self.headers.get("X-Jarvis-Token", "")
        return bool(supplied) and secrets.compare_digest(supplied, API_TOKEN)

    # ── GET ──────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "invalid host"}, 403)
        p = urlparse(self.path).path
        if p == "/api/health":
            # unauthenticated readiness probe (for launchd / monitoring)
            return self._json({"ok": True, "runtime": runtime.runtime_kind()})
        if p == "/api/history":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json({"history": commands.get_history()})
        if p == "/api/settings":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(_merged_settings())
        if p == "/api/models":
            # Models genuinely available for a provider (default: the active one),
            # discovered from the Hermes runtime — never a hardcoded list.
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            want = (parse_qs(urlparse(self.path).query).get("provider") or [""])[0]
            return self._json(runtime.models_catalog(want or None))
        if p == "/api/greeting":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            out = build_greeting()
            q = parse_qs(urlparse(self.path).query)
            if (q.get("claim") or [""])[0] == "1":     # the first gesture of the day asks to speak it
                out["speak"] = claim_greeting(busy=(q.get("busy") or [""])[0] == "1")
            return self._json(out)
        if p == "/api/phrases":
            # stock lines the UI says itself (job news, approval re-asks); see phrases.json
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json({"lines": phrases.all_lines()})
        if p == "/api/status":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            api_ok = runtime.api_backend_ready()
            model = runtime.model_info()
            return self._json(dict(
                runtime=runtime.runtime_kind(),
                permission=runtime.PERMISSION,
                profile=runtime.PROFILE,
                source=runtime.SOURCE,
                workdir=runtime.WORKDIR,
                model=model["model_name"],
                model_provider=model["model_provider"],
                tools=runtime.hermes_tools_snapshot(),
                browser_stt=True,
                browser_tts=True,
                voice_id=voice.voice_label(),
                stt=voice.stt_engine(),
                tts=voice.tts_engine(),
                voice_ready=voice.ready(),
                session=SESSION["id"],
                backend=("api" if api_ok else "cli"),
                backend_note=runtime.gateway_status()[1],
                approvals=api_ok))
        if p == "/api/brain/graph":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(brain.graph())
        if p == "/api/departments":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(brain.departments())
        if p == "/api/brain/note":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            name = (parse_qs(urlparse(self.path).query).get("id") or [""])[0]
            found = brain.note(name)
            return self._json(found if found else {"error": "not found"}, 200 if found else 404)
        if p == "/api/brain/suggest":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            name = (parse_qs(urlparse(self.path).query).get("id") or [""])[0]
            found = brain.suggestions(name)
            return self._json(found if found else {"error": "not found"}, 200 if found else 404)
        if p == "/api/agents":
            # local-only: loopback peer AND loopback Host, plus the session token
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(commands.agents_snapshot())
        if p == "/api/inbox":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(brain.inbox_list())
        if p == "/api/attachments":
            # read-only inventory of composer attachments; local loopback only
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            day = (parse_qs(urlparse(self.path).query).get("day") or [""])[0].strip()
            if day and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                return self._json({"error": "day must be YYYY-MM-DD"}, 400)
            return self._json(attachments_list(day or None))
        if p == "/api/activity":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            snap = commands.agents_snapshot()
            inb = brain.inbox_list()
            pod_items = []
            for n in ("pod-idea-queue", "concept-engine-review", "weekly-review-template"):
                found = brain.note(n)
                if found:
                    pod_items.append({"id": found["id"], "path": found["path"],
                                      "preview": (found["text"] or "")[:360]})
            return self._json(dict(
                now=snap["now"],
                running=snap["running"],
                agents=snap["agents"],
                inbox=inb.get("items", [])[:30],
                inbox_root=inb.get("root", ""),
                pod=pod_items,
            ))
        if p == "/api/brief":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(brief.state())
        if p == "/api/jobs":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            # finished helper jobs (handoff + /background), reported once each
            return self._json(dict(done=commands.take_finished(),
                                   running=[j for j in commands.jobs_snapshot()
                                            if j["status"] == "running"]))

        rel = "index.html" if p == "/" else p.lstrip("/")
        f = (UI / rel).resolve()
        ui_root = UI.resolve()
        # commonpath (not a prefix match) so a sibling dir like `/ui_evil` can't
        # pass the containment check
        if os.path.commonpath([f, ui_root]) != str(ui_root) or not f.is_file():
            return self._bytes(b"not found", "text/plain", 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        data = f.read_bytes()
        if rel == "index.html":
            data = data.replace(b"__JARVIS_TOKEN__", API_TOKEN.encode())
        return self._bytes(data, ctype)

    # ── POST ─────────────────────────────────────────────────
    def do_POST(self):
        p = urlparse(self.path).path
        if not self._host_ok() or not self._origin_ok():
            return self._json({"error": "request origin rejected"}, 403)
        if not self._token_ok():
            return self._json({"error": "unauthorized"}, 401)
        if p in ("/api/speak", "/api/listen"):
            _VOICE_AT[0] = time.monotonic()            # Atlas is talking: not the moment to restart
        ctype = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if p in {"/api/run", "/api/speak", "/api/new", "/api/cancel", "/api/settings", "/api/approval", "/api/inbox",
                 "/api/brain/note", "/api/brain/link", "/api/agents/stop", "/api/brief",
                 "/api/models/test"} and ctype != "application/json":
            return self._json({"error": "application/json required"}, 415)
        if p == "/api/listen" and not ctype.startswith("audio/"):
            return self._json({"error": "audio content type required"}, 415)

        if p == "/api/attach":
            # Chat composer drop area: raw file bytes in the body, ?name=&kind= in the URL.
            # Saves under <project>/attachments/<date>/ and returns the ABSOLUTE path for
            # the UI to put in the message text. Streamed to disk, never read into memory.
            # Deliberately separate from /api/inbox: no Brain note, no ~/Atlas write.
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            if ctype != "application/octet-stream":
                return self._json({"error": "application/octet-stream required"}, 415)
            try:
                length = int(self.headers.get("Content-Length", 0))
            except (TypeError, ValueError):
                return self._json({"error": "bad Content-Length"}, 400)
            q = parse_qs(urlparse(self.path).query)
            info, err = attach_save((q.get("name") or [""])[0], self.rfile, length,
                                    (q.get("kind") or [""])[0])
            if err:
                return self._json({"ok": False, "error": err}, 413 if "larger" in err else 400)
            return self._json({"ok": True, **(info or {})})

        try:
            limit = (MAX_AUDIO_BODY if p == "/api/listen"
                     else MAX_INBOX_BODY if p == "/api/inbox"
                     else MAX_JSON_BODY)
            raw = self._read(limit)
        except (TypeError, ValueError):
            return self._json({"error": "request body too large"}, 413)

        if p == "/api/inbox":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            if body.get("action") in ("file", "status", "discard"):
                res, err = brain.inbox_action(body)
                if err:
                    return self._json({"ok": False, "error": err}, 400)
                return self._json({"ok": True, "item": res})
            item, err = brain.inbox_save(body)
            if err:
                return self._json({"ok": False, "error": err}, 400)
            return self._json({"ok": True, "item": item})

        if p in ("/api/brain/note", "/api/brain/link"):
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            if p == "/api/brain/link":
                res, err = brain.add_link(str(body.get("source") or ""), str(body.get("target") or ""))
            elif body.get("create"):
                res, err = brain.create_note(body.get("create"), str(body.get("near") or "") or None)
            else:
                res, err = brain.save_note(str(body.get("id") or ""), body.get("text"), body.get("base_mtime"))
            if err:
                return self._json({"ok": False, "error": err}, 409 if err.startswith("conflict") else 400)
            return self._json({"ok": True, "note": res})

        if p == "/api/brief":
            # {"refresh": true} = fetch now; {"auto": true} = only if today's isn't done/started
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            return self._json(brief.start(force=bool(body.get("refresh"))))

        if p == "/api/agents/stop":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            res, err = commands.stop_job(body.get("id"))
            return self._json({"ok": False, "error": err} if err else {"ok": True, **res}, 409 if err else 200)

        if p == "/api/speak":
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            try:
                text = str(body.get("text") or "").strip()
                data, mime = voice.speak(text)
                return self._bytes(data, mime)
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:200]}, 503)

        if p == "/api/listen":
            try:
                mime = self.headers.get("Content-Type", "audio/webm")
                return self._json({"text": voice.transcribe(raw, mime)})
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:300], "text": ""}, 503)

        if p == "/api/approval":
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            ok, res = runtime.resolve_approval(body.get("run_id"), body.get("request_id"), body.get("choice"))
            return self._json({"ok": True, **(res if isinstance(res, dict) else {})} if ok
                              else {"ok": False, "error": res}, 200 if ok else 409)

        if p == "/api/new":
            runtime.cancel_active()
            _drop_session()
            return self._json({"ok": True})

        if p == "/api/cancel":
            # Stop the turn but keep the conversation: SESSION only ever holds the last
            # *completed* session, so it is still valid after an interrupted run.
            stopped = runtime.cancel_active()
            return self._json({"ok": True, "stopped": stopped})

        if p == "/api/settings":
            updates = self._obj(raw)
            if updates is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            cleaned, err = commands.set_settings(updates)
            if err:
                return self._json({"error": err}, 400)
            runtime.apply_settings(cleaned)
            voice.apply_settings(cleaned)
            voice.prewarm(phrases.prewarm_lines())      # a new voice or speed: re-record stock lines
            return self._json(_merged_settings())

        if p == "/api/models/test":
            # One trivial prompt through the chosen provider/model, to prove the
            # round-trip before relying on it. Nothing is persisted.
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json({"error": "local only"}, 403)
            body = self._obj(raw)
            if body is None:
                return self._json({"error": "payload must be a JSON object"}, 400)
            return self._json(runtime.test_model(body.get("provider"), body.get("model")))

        if p == "/api/run":
            if not RUN_LOCK.acquire(blocking=False):
                return self._json({"error": "ATLAS is already processing a request"}, 409)
            try:
                return self._stream_run(raw)
            finally:
                RUN_LOCK.release()

        return self._json({"error": "no such endpoint"}, 404)

    # ── the run: NDJSON stream of events ─────────────────────
    def _stream_run(self, raw):
        payload = self._obj(raw)
        if payload is None:
            return self._json({"error": "payload must be a JSON object"}, 400)
        message = str(payload.get("message") or "").strip()
        original_message = message
        extra = str(payload.get("system") or "").strip()
        system = "\n\n".join(x for x in (persona(), extra) if x) or None
        fresh = bool(payload.get("fresh"))
        if not message:
            return self._json({"error": "empty message"}, 400)
        if fresh:
            _drop_session()
            commands.clear_history()

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._security_headers()
        self.end_headers()

        def emit(ev):
            self.wfile.write((json.dumps(ev) + "\n").encode())
            self.wfile.flush()

        # ── the command matrix: /new /profile /goal /personality /kanban /mission /background /tools /status /browser
        # (/background hands the mission to a detached tools/handoff.py helper)
        cmd = commands.handle(message)
        if cmd:
            if cmd.get("note"):
                emit(dict(t="note", message=cmd["note"]))
            if cmd.get("ui"):
                emit(dict(t="ui", ui=cmd["ui"]))       # e.g. voice "show me pricing in my brain"
            if cmd.get("fresh"):
                _drop_session()
                commands.clear_history()
            if cmd.get("message") is None:
                # answered locally — no model call needed
                emit(dict(t="delta", text=cmd.get("reply", "Done.")))
                emit(dict(t="complete", ms=0))
                return
            message = cmd["message"]
            system = "\n\n".join(x for x in (persona(), extra) if x) or None

        try:
            for ev in runtime.run(message, SESSION["id"], system):
                # Only remember a real Hermes session, never demo/mock identifiers.
                sid = ev.get("session_id")
                # Only remember a session that actually COMPLETED. Storing it from
                # `status` (which fires at init) means one broken run poisons every
                # run after it with --resume <half-born session>.
                if ev.get("t") == "complete":
                    ERROR_STREAK["n"] = 0
                if ev.get("t") == "complete" and runtime.valid_session(sid):
                    SESSION["id"] = sid
                    commands.set_session(sid)
                    text = (ev.get("text") or "").strip()
                    if text:
                        commands.record_turn(original_message, text)
                if ev.get("t") == "error":
                    ERROR_STREAK["n"] += 1
                    if ERROR_STREAK["n"] >= 2:      # drop a bad/stale session so the next run is fresh
                        _drop_session()
                if ev.get("drop_session"):
                    # The gateway refused this conversation (a 409 on resume) — permanent,
                    # unlike a 429 or an idle stop. Drop it now rather than resuming a
                    # thread it has already refused on every turn that follows.
                    _drop_session()
                emit(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass                                          # client navigated away
        except Exception as e:                            # noqa: BLE001
            try:
                emit(dict(t="error", message=str(e)[:300]))
            except OSError:
                pass


class JarvisServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if _ERR_LOG:
            _ERR_LOG.exception("unhandled error from %s", client_address)
        super().handle_error(request, client_address)


def main():
    kind = runtime.runtime_kind()
    brain = ("Hermes Agent (profile tools, skills, memory, MCP, browser integrations live)"
             if kind == "hermes" else "MOCK — Hermes CLI not reachable")
    vo = (f"Kokoro ({voice.KOKORO_VOICE}) + Parakeet — local, warming up…" if voice.worker_installed()
          else "local worker not installed (run ./install-voice.sh) — falling back to say / browser")
    perm = runtime.PERMISSION
    backend = {"cli": "Hermes CLI, one process per turn",
               "api": "Hermes API server (falls back to the CLI, with a note)",
               }.get(runtime.BACKEND, "Hermes API server when up (gateway auto-start), else the CLI")
    perm_note = ("  can run tools without asking — set JARVIS_PERMISSION=default to require approval"
                 if perm == "bypass" else "")

    print(f"""
  ATLAS · Hermes Live HUD
  ──────────────────────────────────────────────
  brain        {brain}
  profile      {runtime.PROFILE}
  workdir      {runtime.WORKDIR}
  permission   {perm}{perm_note}
  backend      {backend}
  voice        {vo}
  open         http://localhost:{PORT}
""", flush=True)

    _setup_error_log()
    RESTART_FLAG.unlink(missing_ok=True)       # a request left over from before this launch is done
    threading.Thread(target=_restart_watcher, daemon=True).start()
    runtime.start_gateway(_env)                # keep Hermes warm (no-op for JARVIS_BACKEND=cli)
    # launchd stops us with SIGTERM: turn it into a normal shutdown so our gateway stops too
    import signal

    def _on_term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _on_term)
    voice.start_async()
    voice.prewarm(phrases.prewarm_lines())     # stock lines play instantly once recorded
    phrases.on_change = lambda: voice.prewarm(phrases.prewarm_lines())   # lines added while running
    runtime.prewarm_probes(background=True)   # first turn must not pay for `hermes --version` / `tools list`
    srv = JarvisServer(("127.0.0.1", PORT), Handler)
    if os.environ.get("JARVIS_OPEN", "1") != "0":
        webbrowser.open(f"http://localhost:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  down.")
    finally:
        runtime.stop_gateway()
        srv.server_close()


if __name__ == "__main__":
    main()
