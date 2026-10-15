"""Local voice worker: Kokoro (TTS) + Parakeet (STT), both on Apple Silicon via MLX.

Runs inside .venv-voice as a long-lived child of server.py so the models load
once. Protocol: one JSON object per line on stdin, one JSON reply per line on
stdout.  Library chatter is forced onto stderr so stdout stays clean.

  {"op":"tts","text":"...","out":"/tmp/x.wav","voice":"bm_george","speed":1.0}
  {"op":"stt","path":"/tmp/in.webm"}
  {"op":"ping"}
"""
import json
import os
import sys

_real_out = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)                       # anything that print()s now lands on stderr
sys.stdout = sys.stderr

TTS_MODEL = os.environ.get("JARVIS_KOKORO_MODEL", "mlx-community/Kokoro-82M-bf16")
STT_MODEL = os.environ.get("JARVIS_STT_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
SR = 24000

_tts = _stt = None


def tts_model():
    global _tts
    if _tts is None:
        from mlx_audio.tts.utils import load_model
        _tts = load_model(TTS_MODEL)
    return _tts


def stt_model():
    global _stt
    if _stt is None:
        from parakeet_mlx import from_pretrained
        _stt = from_pretrained(STT_MODEL)
    return _stt


def do_tts(req):
    import numpy as np
    import soundfile as sf
    voice = req.get("voice") or "bm_george"
    lang = "b" if voice.startswith("b") else "a"
    parts = [np.array(r.audio).reshape(-1) for r in tts_model().generate(
        text=req["text"], voice=voice, speed=float(req.get("speed") or 1.0), lang_code=lang)]
    if not parts:
        raise RuntimeError("Kokoro produced no audio")
    audio = np.concatenate(parts)
    sf.write(req["out"], audio, SR)
    return {"ok": True, "seconds": round(len(audio) / SR, 2)}


def do_stt(req):
    return {"ok": True, "text": (stt_model().transcribe(req["path"]).text or "").strip()}


def main():
    # Warm both models up front so the first spoken turn isn't a 30s stall.
    try:
        tts_model(); stt_model()
        print(json.dumps({"ready": True}), file=_real_out, flush=True)
    except Exception as e:                                   # noqa: BLE001
        print(json.dumps({"ready": False, "error": str(e)[:300]}), file=_real_out, flush=True)
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            res = (do_tts(req) if op == "tts" else do_stt(req) if op == "stt"
                   else {"ok": True} if op == "ping" else {"ok": False, "error": "bad op"})
        except Exception as e:                               # noqa: BLE001
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        print(json.dumps(res), file=_real_out, flush=True)


if __name__ == "__main__":
    main()
