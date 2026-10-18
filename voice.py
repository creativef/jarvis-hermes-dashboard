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
# Kokoro voices offered in Settings (first letter: a = US, b = British; second: f/m).
VOICES = ("bm_george", "bm_daniel", "bm_fable", "bm_lewis", "am_adam", "am_michael",
          "bf_emma", "bf_isabella", "af_heart")
SPEED_MIN, SPEED_MAX = 0.6, 1.6
WARM_TIMEOUT = 600      # first run downloads models
REQ_TIMEOUT = 60

_lock = threading.Lock()        # one request at a time through the worker
_proc = None
_state = {"ready": False, "error": ""}
_start_lock = threading.Lock()

# Short phrases (acknowledgements, greetings, status) are cached once synthesised.
_AUDIO_CACHE = {}
_AUDIO_CACHE_LOCK = threading.Lock()
_AUDIO_CACHE_MAX = 64
SHORT_CACHE_MAX_CHARS = 180

def apply_settings(settings):
    """Use the voice / speed chosen in Settings (state.json) from the next sentence on."""
    global KOKORO_VOICE, KOKORO_SPEED
    if settings.get("voice"):
        KOKORO_VOICE = str(settings["voice"])
    if settings.get("voice_speed"):
        KOKORO_SPEED = float(settings["voice_speed"])


def clear_audio_cache():
    with _AUDIO_CACHE_LOCK:
        _AUDIO_CACHE.clear()


def _disabled():
    return os.environ.get("JARVIS_LOCAL_VOICE", "1") == "0"


def worker_installed():
    return VENV_PY.exists() and WORKER.exists() and not _disabled()


def _spawn():
    """Start the worker and wait (at most WARM_TIMEOUT) for its ready line."""
    global _proc
    log = HERE / "logs" / "voice_worker.log"
    log.parent.mkdir(exist_ok=True)
    if log.exists() and log.stat().st_size > 1_000_000:      # keep one old copy, not forever
        log.replace(log.with_name("voice_worker.log.1"))
    with open(log, "ab") as err:                            # the child keeps its own copy
        _proc = subprocess.Popen(
            [str(VENV_PY), str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=err, text=True, bufsize=1, cwd=str(HERE))
    first = []
    reader = threading.Thread(target=lambda: first.append(_proc.stdout.readline()), daemon=True)
    reader.start()
    reader.join(WARM_TIMEOUT)
    if reader.is_alive():                                   # a stalled download must not hang us
        _proc.kill()
        reader.join(2)
        for pipe in (_proc.stdin, _proc.stdout):
            pipe.close()
        _proc.wait(timeout=2)
        _state.update(ready=False, error=f"voice worker not ready after {WARM_TIMEOUT:g}s")
        return
    msg = json.loads(first[0]) if first and first[0] else {"ready": False, "error": "worker exited"}
    _state["ready"] = bool(msg.get("ready"))
    _state["error"] = msg.get("error", "")


def start_async():
    """Start (or restart) the worker in the background. Never blocks the caller."""
    if not worker_installed():
        return

    def run():
        with _start_lock:
            if _proc is None or _proc.poll() is not None:
                try:
                    _spawn()
                except Exception as e:                       # noqa: BLE001
                    _state.update(ready=False, error=str(e)[:200])
    threading.Thread(target=run, daemon=True).start()


def _call(req, timeout=REQ_TIMEOUT):
    """Send one request to the worker and wait for its reply.

    Fails at once while the worker is warming up or restarting, so callers fall back
    (macOS `say`, browser speech) instead of waiting tens of seconds for model loads."""
    if not worker_installed():
        raise RuntimeError("local voice not installed (.venv-voice missing)")
    if not _start_lock.acquire(blocking=False):
        raise RuntimeError("voice worker is warming up")
    try:
        alive = _proc is not None and _proc.poll() is None
    finally:
        _start_lock.release()
    if not alive:
        start_async()
        raise RuntimeError("voice worker is restarting: " + (_state["error"] or "starting"))
    if not _state["ready"]:
        raise RuntimeError("voice worker failed to start: " + (_state["error"] or "unknown"))
    proc = _proc
    with _lock:
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        timer = threading.Timer(timeout, proc.kill)    # a hung model must not wedge the server
        timer.start()
        try:
            line = proc.stdout.readline()
        finally:
            timer.cancel()
    if not line:
        start_async()                                  # bring it back for the next request
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
            cache_key = None                 # fallback audio must not be cached as Kokoro's
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
