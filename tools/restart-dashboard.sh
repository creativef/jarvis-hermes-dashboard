#!/usr/bin/env bash
# Restart the Atlas dashboard SAFELY (e.g. after editing server.py / runtime.py).
#
# Never kill the server on port 8730 or voice_worker.py directly: that cuts Atlas off
# mid-reply, blanks the open tab and swaps to the fallback voice. This only asks the
# server to restart itself; it does so between turns, once Atlas has finished speaking,
# and the open tab stays connected.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${JARVIS_PORT:-8730}"
mkdir -p logs
if curl -fs -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  touch logs/restart-requested
  echo "Restart requested: the dashboard restarts itself once the current reply has been spoken."
else
  JARVIS_OPEN=0 nohup ./start.sh >> logs/atlas-restart.log 2>&1 &
  echo "The dashboard was not running, so it has been started."
fi
