"""
Local voice for JARVIS — no cloud, no API keys.

  TTS  Kokoro-82M      (Apache-2.0)  via MLX on the Apple GPU
  STT  Parakeet TDT 0.6B v3          via MLX

Both models live in a long-running worker process (voice_worker.py, run from
.venv-voice) so they load once. Fallbacks when the worker/venv is missing:
macOS `say` for speech out, browser SpeechRecognition for speech in.
The browser asks /api/speak for audio and /api/listen for text; nothing leaves
the machine.
"""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading

HERE = pathlib.Path(__file__).resolve().parent
VENV_PY = HERE / ".venv-voice" / "bin" / "python"
WORKER = HERE / "voice_worker.py"

KOKORO_VOICE = os.environ.get("JARVIS_KOKORO_VOICE", "bm_george")   # British male
KOKORO_SPEED = float(os.environ.get("JARVIS_KOKORO_SPEED", "1.0"))
LOCAL_VOICE = os.environ.get("JARVIS_SAY_VOICE", "Daniel")          # `say` fallback
WARM_TIMEOUT = 600      # first run downloads models
REQ_TIMEOUT = 60

_lock = threading.Lock()        # one request at a time through the worker
_proc = None
_state = {"ready": False, "error": ""}
_start_lock = threading.Lock()

# Pre-generated / cached short-phrase audio (acknowledgements, greetings, status)
# so acknowledgement-first voice replies play with zero synthesis delay.
_AUDIO_CACHE = {}
_AUDIO_CACHE_LOCK = threading.Lock()
_AUDIO_CACHE_MAX = 64
SHORT_CACHE_MAX_CHARS = 180

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
    """Return a short acknowledgement phrase chosen by intent."""
    if message in ACK_PHRASES:
        return ACK_PHRASES[message]
    return ACK_PHRASES.get(classify_ack_intent(message), ACK_PHRASES["default"])


def clear_audio_cache():
    with _AUDIO_CACHE_LOCK:
        _AUDIO_CACHE.clear()


def _disabled():
    return os.environ.get("JARVIS_LOCAL_VOICE", "1") == "0"


def worker_installed():
    return VENV_PY.exists() and WORKER.exists() and not _disabled()


def _spawn():
    global _proc
    _proc = subprocess.Popen(
        [str(VENV_PY), str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=open(HERE / "logs" / "voice_worker.log", "ab"), text=True, bufsize=1,
        cwd=str(HERE))
    first = _proc.stdout.readline()
    msg = json.loads(first) if first else {"ready": False, "error": "worker exited"}
    _state["ready"] = bool(msg.get("ready"))
    _state["error"] = msg.get("error", "")


def start_async():
    """Kick off the worker in the background (called at server boot)."""
    if not worker_installed():
        return
    (HERE / "logs").mkdir(exist_ok=True)

    def run():
        with _start_lock:
            if _proc is None or _proc.poll() is not None:
                try:
                    _spawn()
                except Exception as e:                       # noqa: BLE001
                    _state.update(ready=False, error=str(e)[:200])
    threading.Thread(target=run, daemon=True).start()


def _call(req, timeout=REQ_TIMEOUT):
    """Send one request to the worker and wait for its reply."""
    if not worker_installed():
        raise RuntimeError("local voice not installed (.venv-voice missing)")
    with _start_lock:                       # waits while the worker is still warming
        if _proc is None or _proc.poll() is not None:
            _spawn()
    if not _state["ready"]:
        raise RuntimeError("voice worker failed to start: " + (_state["error"] or "unknown"))
    with _lock:
        _proc.stdin.write(json.dumps(req) + "\n")
        _proc.stdin.flush()
        timer = threading.Timer(timeout, _proc.kill)   # a hung model must not wedge the server
        timer.start()
        try:
            line = _proc.stdout.readline()
        finally:
            timer.cancel()
    if not line:
        raise RuntimeError("voice worker died mid-request")
    res = json.loads(line)
    if not res.get("ok"):
        raise RuntimeError(res.get("error", "voice worker error"))
    return res


def local_available():
    return shutil.which("say") is not None


def tts_engine():
    if worker_installed() and (_state["ready"] or _proc is None or _proc.poll() is None):
        return "kokoro"
    return "local" if local_available() else "browser"


def stt_engine():
    return "parakeet" if worker_installed() else "browser"


def voice_label():
    return KOKORO_VOICE if tts_engine() == "kokoro" else (
        LOCAL_VOICE if local_available() else "browser")


def ready():
    return _state["ready"]


def _speak_say(text):
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(["say", "-v", LOCAL_VOICE, "-o", path,
                        "--data-format=LEI16@22050", text[:2500]],
                       check=True, capture_output=True, timeout=30)
        return pathlib.Path(path).read_bytes()
    finally:
        pathlib.Path(path).unlink(missing_ok=True)


def speak(text):
    """Returns (audio_bytes, mime_type). Raises if no engine is available."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    clipped = text[:2500]
    cache_key = None
    if len(clipped) <= SHORT_CACHE_MAX_CHARS:
        cache_key = (tts_engine(), voice_label(), KOKORO_SPEED, clipped)
        with _AUDIO_CACHE_LOCK:
            cached = _AUDIO_CACHE.get(cache_key)
        if cached is not None:
            return cached

    result = None
    if worker_installed():
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            _call({"op": "tts", "text": clipped, "out": path,
                   "voice": KOKORO_VOICE, "speed": KOKORO_SPEED})
            result = (pathlib.Path(path).read_bytes(), "audio/wav")
        except Exception:                                    # noqa: BLE001
            if not local_available():
                raise
        finally:
            pathlib.Path(path).unlink(missing_ok=True)
    if result is None and local_available():
        result = (_speak_say(clipped), "audio/wav")
    if result is None:
        raise RuntimeError("no TTS engine available")

    if cache_key is not None:
        with _AUDIO_CACHE_LOCK:
            if len(_AUDIO_CACHE) >= _AUDIO_CACHE_MAX:
                _AUDIO_CACHE.pop(next(iter(_AUDIO_CACHE)), None)
            _AUDIO_CACHE[cache_key] = result
    return result


def prewarm_acks():
    """Pre-generate audio for the fixed acknowledgement pool so ack replies have no synthesis delay."""
    count = 0
    for phrase in dict.fromkeys(ACK_PHRASES.values()):
        try:
            speak(phrase)
            count += 1
        except Exception:                                    # noqa: BLE001
            break
    return count


def speak_stream(items):
    """Stream TTS audio sentence-by-sentence from runtime events (`ack`/`sentence`) or plain strings."""
    for item in items:
        if isinstance(item, str):
            kind, text = "sentence", item.strip()
        elif isinstance(item, dict) and item.get("t") in ("ack", "sentence"):
            kind, text = item.get("t"), (item.get("text") or "").strip()
        else:
            continue
        if not text:
            continue
        audio, mime = speak(text)
        yield {"type": kind, "text": text, "audio": audio, "mime": mime}


def transcribe(audio, mime="audio/webm"):
    """Speech to text with Parakeet. Returns the transcript, or raises."""
    if not audio:
        raise ValueError("empty audio")
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4",
           "audio/mpeg": "mp3", "audio/wav": "wav"}.get(mime.split(";")[0].strip(), "webm")
    fd, path = tempfile.mkstemp(suffix="." + ext)
    os.close(fd)
    try:
        pathlib.Path(path).write_bytes(audio)
        return _call({"op": "stt", "path": path})["text"]
    finally:
        pathlib.Path(path).unlink(missing_ok=True)
