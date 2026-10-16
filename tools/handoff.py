#!/usr/bin/env python3
"""Hand a long job to a detached helper so Atlas stays free to talk.

Usage:  python3 tools/handoff.py "the job, written as a full brief"

Prints a job id and returns immediately. The helper runs in its own process,
writes its outcome to logs/handoff/<id>.json, and the dashboard announces it
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

RULES = (
    "You are a helper working for Atlas on a job for Mr Thompson. Do the job fully "
    "and carefully. Never send messages or emails, spend money, or commit him to "
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


def worker(jid, mission):
    sys.path.insert(0, str(ROOT))
    import runtime
    path = HANDOFF_DIR / f"{jid}.json"
    job = json.loads(path.read_text(encoding="utf-8"))
    status, text = "done", ""
    try:
        proc = subprocess.run(runtime.build_command(mission, None), input=RULES + mission,
                              text=True, capture_output=True, cwd=runtime.WORKDIR,
                              timeout=3600)
        final = ""
        for line in proc.stdout.splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "result":
                final = ev.get("text") or final
            elif ev.get("type") == "text" and not final:
                text += ev.get("text") or ""
        text = (final or text).strip()
        if proc.returncode != 0 and not text:
            status, text = "failed", (proc.stderr or "helper exited with an error")[-260:]
    except Exception as e:  # noqa: BLE001
        status, text = "failed", f"{e}"[:260]
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
