"""
Text to speech.

ElevenLabs when a key is present, browser speechSynthesis otherwise.

The key stays here, server-side. The browser asks /api/speak for audio and gets
mp3 bytes back — it never sees the key, so nothing leaks into devtools, the
page source, or a screen recording.
"""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

# Rachel — calm, British-adjacent. Override with ELEVENLABS_VOICE_ID.
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_turbo_v2_5")
# Local (offline) voice via macOS `say`. "Daniel" is a calm British male that
# fits the JARVIS persona; override with JARVIS_SAY_VOICE.
LOCAL_VOICE = os.environ.get("JARVIS_SAY_VOICE", "Daniel")


def available():
    return bool(os.environ.get("ELEVENLABS_API_KEY"))


def local_available():
    return shutil.which("say") is not None


def tts_engine():
    if available():
        return "elevenlabs"
    if local_available():
        return "local"
    return "browser"


def voice_id():
    return os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE)


def _speak_elevenlabs(text):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id()}",
        data=json.dumps({
            "text": text[:2500],
            "model_id": MODEL,
            "voice_settings": {
                "stability": 0.42,          # a little variation; 0.5+ goes flat
                "similarity_boost": 0.85,
                "style": 0.25,
                "use_speaker_boost": True,
            },
        }).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "audio/mpeg",
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _speak_local(text):
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
    if available():
        return _speak_elevenlabs(text), "audio/mpeg"
    if local_available():
        return _speak_local(text), "audio/wav"
    raise RuntimeError("no TTS engine (set ELEVENLABS_API_KEY or run on macOS)")


def transcribe(audio, mime="audio/webm"):
    """Speech to text via ElevenLabs Scribe. Returns the transcript, or raises.

    Used instead of the browser's Web Speech API because that one only exists in
    Chrome and is a silently-failing stub in Brave — and because it ships your
    audio to Google. This keeps listening on the same provider as speaking.
    """
    if not available():
        raise RuntimeError("no ELEVENLABS_API_KEY")
    if not audio:
        raise ValueError("empty audio")

    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4",
           "audio/mpeg": "mp3", "audio/wav": "wav"}.get(mime.split(";")[0], "webm")
    boundary = "----jarvis" + os.urandom(8).hex()
    b = boundary.encode()

    body = b"".join([
        b"--", b, b"\r\n",
        b'Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n',
        b"--", b, b"\r\n",
        f'Content-Disposition: form-data; name="file"; filename="turn.{ext}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        audio, b"\r\n",
        b"--", b, b"--\r\n",
    ])

    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text",
        data=body, method="POST",
        headers={
            "content-type": f"multipart/form-data; boundary={boundary}",
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
        },
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return (json.loads(r.read()).get("text") or "").strip()


def voices():
    """List the account's voices, so you can find an id to put in .env."""
    if not available():
        return []
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v2/voices",
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
    except Exception:                                  # noqa: BLE001
        return []
    return [dict(id=v.get("voice_id"), name=v.get("name"),
                 labels=v.get("labels", {}))
            for v in body.get("voices", [])]
