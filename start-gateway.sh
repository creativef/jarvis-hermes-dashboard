#!/usr/bin/env bash
# Starts the Hermes API server that gives JARVIS real, per-command approvals.
#
#   JARVIS_BACKEND=api   (in .env)  makes the dashboard talk to it
#
# What it does:
#   * creates a private API key in .env the first time (gitignored, chmod 600)
#   * binds to 127.0.0.1 only — never the network
#   * does nothing if the server is already up
#
# Note: `hermes gateway run` also runs Hermes's cron scheduler and any messaging
# platforms you have configured. If something else already runs your gateway,
# point JARVIS_API_URL at that one instead of starting a second.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

URL="${JARVIS_API_URL:-$(get JARVIS_API_URL)}"; URL="${URL:-http://127.0.0.1:8642}"
KEY="${JARVIS_API_KEY:-$(get JARVIS_API_KEY)}"
if [ -z "$KEY" ]; then
  KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  printf '\n# Hermes API server key (start-gateway.sh)\nJARVIS_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
  echo "created a new API key in $ENV_FILE"
fi

if curl -fs -m 2 "$URL/health" >/dev/null 2>&1; then
  echo "Hermes API server already running at $URL"; exit 0
fi

PORT="${URL##*:}"; PORT="${PORT%%/*}"
export API_SERVER_ENABLED=true API_SERVER_KEY="$KEY" API_SERVER_HOST=127.0.0.1 API_SERVER_PORT="$PORT"
echo "starting Hermes API server on 127.0.0.1:$PORT (Ctrl-C to stop)"
exec "${HERMES_BIN:-hermes}" gateway run
