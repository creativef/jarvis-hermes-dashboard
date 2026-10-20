#!/usr/bin/env python3
"""Hand a long job to a detached helper so Atlas stays free to talk.

Usage:  python3 tools/handoff.py "the job, written as a full brief"

Prints a job id and returns immediately. The helper runs in its own process,
writes its outcome to logs/handoff/<id>.json (live progress lines: <id>.log), and the dashboard announces it
once when it lands. Nothing here binds a port or touches the network.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
HANDOFF_DIR = ROOT / "logs" / "handoff"

STATE_FILE = pathlib.Path(os.environ.get("JARVIS_STATE", ROOT / "state.json"))


def _settings():
    """The dashboard's Settings (state.json). Read directly: importing commands would
    reconcile the live server's state as a side effect."""
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8")).get("settings") or {}
    except (OSError, ValueError, AttributeError):
        return {}


def rules(name=""):
    who = name or "the user"
    return (
        f"You are a helper working for Atlas on a job for {who}. Do the job fully "
        "and carefully. Never send messages or emails, spend money, or commit them to "
        "anything. When finished, reply with one or two plain spoken sentences "
        "stating the outcome: no markdown, no lists, no process narration.\n\nJOB:\n"
    )


def _write(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def launch(mission):
    HANDOFF_DIR.mkdir(parents=True, exist_ok=True)
    jid = uuid.uuid4().hex[:8]
    path = HANDOFF_DIR / f"{jid}.json"
    _write(path, {"id": jid, "status": "running", "mission": mission[:200],
                  "result": "", "started": time.time(), "finished": None})
    subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()),
                      "--worker", jid, mission],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True,
                     cwd=str(ROOT))
    return jid


def _brief_event(ev):
    """One short human line for a stream-json event (the dashboard's live 'step')."""
    kind = str(ev.get("type") or "event")
    detail = ev.get("text") or ev.get("name") or ev.get("tool") or ev.get("message") or ""
    if isinstance(detail, (dict, list)):
        detail = json.dumps(detail)
    detail = " ".join(str(detail).split())
    return (f"{kind}: {detail}" if detail else kind)[:240]


def worker(jid, mission):
    sys.path.insert(0, str(ROOT))
    import runtime
    import threading
    settings = _settings()
    # Same permission / working folder / timeout as the Settings panel shows, not
    # just whatever the environment says (the UI may have tightened .env's choice).
    runtime.apply_settings(settings)
    name = str(settings.get("user_name") or "").strip() or runtime.user_name()
    path = HANDOFF_DIR / f"{jid}.json"
    log_path = HANDOFF_DIR / f"{jid}.log"
    err_path = HANDOFF_DIR / f"{jid}.err"
    job = json.loads(path.read_text(encoding="utf-8"))
    job["pid"] = os.getpid()
    _write(path, job)
    status, text, final = "done", "", ""
    try:
        with open(log_path, "a", encoding="utf-8") as log, open(err_path, "w") as err:
            proc = subprocess.Popen(runtime.build_command(mission, None), stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=err, text=True,
                                    cwd=runtime.WORKDIR)

            def feed():
                try:
                    proc.stdin.write(rules(name) + mission)
                    proc.stdin.close()
                except OSError:
                    pass
            threading.Thread(target=feed, daemon=True).start()
            killer = threading.Timer(3600, proc.kill)
            killer.daemon = True
            killer.start()
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                log.write(f"{time.time():.3f}\t{_brief_event(ev)}\n")
                log.flush()
                if ev.get("type") == "result":
                    final = ev.get("text") or final
                elif ev.get("type") == "text" and not final:
                    text += ev.get("text") or ""
            proc.wait()
            proc.stdout.close()
            killer.cancel()
        text = (final or text).strip()
        if proc.returncode != 0 and not text:
            try:
                tail = err_path.read_text(errors="replace")
            except OSError:
                tail = ""
            status, text = "failed", (tail or "helper exited with an error")[-260:]
    except Exception as e:  # noqa: BLE001
        status, text = "failed", f"{e}"[:260]
    job = json.loads(path.read_text(encoding="utf-8"))
    job.update(status=status, result=text or "Finished with nothing to report.",
               finished=time.time())
    _write(path, job)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 2:
        print(launch(" ".join(sys.argv[1:])))
    else:
        sys.exit(__doc__)
