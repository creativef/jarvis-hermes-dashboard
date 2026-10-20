# JARVIS · Hermes Agent Mission Control

A local, voice-enabled JARVIS dashboard for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It is a visual interface over your existing Hermes profile—not a second agent runtime—so it inherits the same tools, skills, memory, browser automation, MCP servers, and third-party integrations.

![JARVIS Hermes dashboard](docs/screenshot.png)

## What you get

- Futuristic browser-based mission-control HUD
- Natural conversational replies with a concise JARVIS voice persona
- Continuous voice conversation: listen → transcribe → answer → speak → listen
- Local speech-to-text (Parakeet) and text-to-speech (Kokoro), no cloud
- macOS `say` / browser speech fallback if the local voice isn't installed
- Working command matrix and slash commands
- Hermes session continuity across voice turns and dashboard restarts
- Access to the active Hermes profile's tools, skills, browser, memory, and MCP integrations
- Local-only HTTP server bound to `127.0.0.1`
- Fully offline (self-hosted fonts; no CDN requests)
- In-browser settings panel (permission, idle timeout, working directory)
- Durable server error log at `logs/server.log`

## Prerequisites

1. macOS or Linux with Python 3 and a modern Chromium browser.
2. Hermes Agent installed and configured:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
```

Confirm that `hermes chat -q "Say online"` works before installing the dashboard.

## One-command install

```bash
git clone https://github.com/creativef/jarvis-hermes-dashboard.git && \
cd jarvis-hermes-dashboard && \
./install.sh
```

The installer creates a private `.env` file, starts the dashboard, and opens:

<http://127.0.0.1:8730>

No API keys are required for the basic dashboard. Browser speech APIs are used as a fallback.

## One-prompt installation with Hermes

Give this prompt to an already-installed Hermes Agent:

> Install and launch the JARVIS dashboard from https://github.com/creativef/jarvis-hermes-dashboard. Clone or update it under ~/jarvis-hermes-dashboard, preserve any existing private .env file, run its installer, verify http://127.0.0.1:8730/api/status reports the Hermes runtime, and tell me the local dashboard URL. Do not print or expose any credentials.

Hermes can perform the clone, setup, launch, and health check with its terminal tools.

## Voice setup

Fully local, no accounts or API keys (Apple Silicon):

- **Speech out:** Kokoro-82M (Apache-2.0) via MLX
- **Speech in:** NVIDIA Parakeet TDT 0.6B v3 via MLX

```bash
./install-voice.sh   # creates .venv-voice; models (~1.5 GB) download on first start
./start.sh
```

Both models load once into a worker process (`voice_worker.py`) and stay warm.
Measured on an M-series Mac: ~0.8 s to speak a sentence, ~0.4 s to transcribe one.
Choose a voice in `.env` with `JARVIS_KOKORO_VOICE` (default `bm_george`).
Without the venv, it falls back to macOS `say` and browser speech recognition.

## Hermes profile and tools

The dashboard uses the `default` Hermes profile unless overridden:

```bash
HERMES_PROFILE=work ./start.sh
```

If Hermes is installed at a nonstandard location:

```bash
HERMES_CMD="/absolute/path/to/hermes" ./start.sh
```

Third-party applications are connected in Hermes itself—not separately in this dashboard. Typical setup paths are:

```bash
hermes skills browse       # Gmail, Notion, Airtable, Google Workspace, etc.
hermes tools               # built-in toolsets
hermes mcp list            # external MCP servers
hermes gateway setup       # Telegram, Slack, Discord, WhatsApp, etc.
```

After changing Hermes tools or integrations, restart the dashboard or use `/new`.

## Command Matrix

Every button executes its base command immediately. Commands that accept a payload stay armed so the next typed or spoken phrase becomes `/command payload`.

| Command | Action |
|---|---|
| `/new` | Start a fresh Hermes thread |
| `/goal <text\|status\|clear>` | Set, read, or clear the standing objective |
| `/tools` | Run `hermes tools list` |
| `/browser <task>` | Ask Hermes to use its browser/Chrome tools |
| `/background <mission>` | Run a background Hermes mission |
| `/mission [task]` | Read or add to the local mission queue |
| `/personality <tone>` | Read or change the JARVIS tone overlay |
| `/commands` | Show all dashboard commands |
| `/toolsets` | Summarize enabled Hermes toolsets |
| `/connectors` | Explain integration inheritance |
| `/connect <name>` | Request Hermes-native connection guidance |
| `/status` | Show runtime/profile/voice status |

Normal text and voice requests go directly to Hermes Agent.

## Mic gate, greeting and approvals

- **Space** opens / closes the mic (tap to latch). A bulb under the orb shows the state, the tab title and icon mirror it, and the mic auto-closes after a silence timeout (Settings). **Alt+C** (or the 📞 button) is *call mode*: mic locked closed, replies text-only.
- **Greeting:** a short spoken hello once per launch/day, using the name in Settings. Browsers block audio until the page is touched, so he speaks on your first key press or click.
- **Hermes kept warm (default, `JARVIS_BACKEND=auto`):** on launch the dashboard starts `hermes gateway run` with its API server on (port 8642, a private key it saves in `.env`), unless one is already running, and stops it when you stop the dashboard. Turns no longer pay for starting a Hermes process, and the persona travels as Hermes `instructions` so your saved conversation holds only what you said. Until the gateway answers (tools and MCP servers load first), turns use the one-shot CLI. Compare the **TIMING** lines before and after. `JARVIS_BACKEND=cli` turns this off.
  - If you already run a Hermes gateway as a service, Hermes refuses a second one; enable the API server in that one instead (`API_SERVER_ENABLED=true` and `API_SERVER_KEY=<your JARVIS_API_KEY>` in `~/.hermes/.env`, then `hermes gateway restart`). The dashboard's `/status` says which backend is live; details go to `logs/gateway.log`.
- **Approvals (with the API backend):** Hermes' one-shot CLI mode never *asks* about a risky command; it blocks it (or, in Bypass, allows everything). With the API backend Hermes pauses on each flagged command, the dashboard shows the exact command, and Jarvis asks out loud. Answer by voice ("yes" / "no"), or **Enter** / **Esc**.
  - Risky categories (deletes, sending, spending, credentials, force/reset, sudo…) are *keyboard-only*: a spoken "yes" is ignored, though "no" always works.
  - The dashboard can only ever send **once** or **deny**. It never sends "always"/"session", so a spoken yes can't become a standing rule. No answer in 45s means **deny**.
  - Manual alternative: `./start-gateway.sh` runs the same gateway in its own terminal (creates the key in `.env`, binds `127.0.0.1` only); the dashboard then finds it and leaves it alone on exit.
  - Heads-up: `hermes gateway run` also runs Hermes' cron scheduler and any messaging platforms you've configured. Don't start a second one if you already run a gateway; point `JARVIS_API_URL` at it.
  - With `approvals.mode: smart` (Hermes default) low-risk commands are auto-approved and only uncertain ones prompt; use `hermes config set approvals.mode manual` to be asked every time.

## Morning brief and helper jobs

- **Business pulse / Family & calendar cards:** once a day, the first time the brief shows, a quiet helper asks Hermes (read-only) for yesterday's and today's orders, revenue and ad spend from any store or ad account you've connected in Hermes, plus your next few days of events. Results land in `logs/brief/<date>.json`; **↻** on either card fetches fresh numbers. If the last fetch found nothing connected, it stops fetching by itself until you press ↻.
- **Stopping a helper:** in the **Agents** tab, press **Stop** then **Confirm stop** on a running job. Atlas only signals the process it can verify is that job's worker; a worker that already died is simply marked stopped.

## Talking to Atlas

- **Interrupt him by talking (or tap Space).** He *pauses*, he doesn't lose the answer, and listens. Then:
  say nothing or "go on" → he picks up from the start of that sentence · "wait" / "hold on" → stays paused ·
  "stop" → drops the rest · anything else → he answers that, knowing exactly where you cut him off.
  It learns how loud his own voice is in your mic; if it triggers by itself it gets less sensitive. Headphones make it reliable. Toggle: Settings → "Talk over Atlas". Esc still cancels outright.
- **Instant commands, no model call:** "stop", "repeat that", "slower" / "faster", "new topic".
- **Space while you're talking** sends right away instead of waiting for the 1.2 s pause.
- **Voice and speed** are in Settings and apply from the next sentence.
- Each voice turn logs one **TIMING** line (you→text · →first word · →voice) so you can see which step is slow.

## Architecture

```text
Browser HUD
  ├─ microphone → browser MediaRecorder → POST /api/listen → Parakeet (local)
  ├─ POST /api/run → Python NDJSON server
  ├─ Hermes CLI quiet mode → active Hermes profile and tools
  └─ sentences → POST /api/speak → Kokoro (local), macOS say or browser speech
```

Key files:

```text
server.py       local HTTP API and NDJSON streaming
runtime.py      Hermes CLI subprocess and session continuity
commands.py     dashboard slash commands and mission queue
voice.py        local Kokoro/Parakeet worker client, with say/browser fallback
voice_worker.py the model process (runs in .venv-voice)
persona.md      concise spoken JARVIS persona
ui/             dependency-free HTML/CSS/JavaScript HUD (app.js; brain.js = the Brain graph)
tools/handoff.py detached helper jobs (also what /background launches)
install.sh      first-run setup and launch
start.sh        local launcher
```

## Security

- The server binds only to `127.0.0.1`; it is not exposed to the network.
- Every state-changing API request requires a per-launch random token, same-origin request, valid localhost host header, approved content type, and bounded request size.
- Agent runs are serialized so multiple tabs cannot race the shared Hermes session.
- Raw prompt logging is disabled unless `JARVIS_RAW_LOG` is explicitly configured; opt-in logs are created with mode `0600` and symlink protection.
- `.env`, state files, Python caches, and local credentials are ignored by Git.
- The dashboard never bundles Google, Zapier, Gmail, or Hermes credentials.
- Connected apps remain owned and authenticated by the user's Hermes profile.
- Review third-party skills and MCP servers before installing them.

## Manual start

```bash
cd ~/jarvis-hermes-dashboard
./start.sh
```

To use another port:

```bash
JARVIS_PORT=9000 ./start.sh
```

## Run at login (launchd, macOS)

To keep JARVIS running as an always-on background agent that starts at login:

1. Edit `contrib/launchd/com.creativef.jarvis-dashboard.plist` and replace
   `/Users/USERNAME` with your home path (four places).
2. `mkdir -p ~/Library/LaunchAgents`
3. `cp contrib/launchd/com.creativef.jarvis-dashboard.plist ~/Library/LaunchAgents/`
4. `launchctl load ~/Library/LaunchAgents/com.creativef.jarvis-dashboard.plist`

It runs on port 8730 with `JARVIS_OPEN=0` (no auto browser). Health-check it
with `curl http://127.0.0.1:8730/api/health`. Stop it with
`launchctl unload ~/Library/LaunchAgents/com.creativef.jarvis-dashboard.plist`.

## Troubleshooting

### Hermes is not found

```bash
which hermes
hermes doctor
```

Then set `HERMES_CMD` in `.env` if needed.

### Microphone does not activate

Allow microphone access for `127.0.0.1` in the browser's site settings. Without the local voice (./install-voice.sh), use a browser that supports Web Speech APIs.

### A newly connected tool is missing

Start a fresh session after changing Hermes tools:

```bash
hermes tools list
```

Then restart the dashboard and click `/new`.

## Tests

Run the suite with the stdlib `unittest` runner (no extra dependencies):

```
python3 -m unittest discover -s tests -t . -v
```

`tests/fake_hermes` is a stand-in CLI that replays canned `stream-json`, so the
integration test exercises the subprocess machinery without a live Hermes model.

## Credits and license

Originally inspired by [`Itsme23476/jarvis-os`](https://github.com/Itsme23476/jarvis-os), redesigned and adapted to use Hermes Agent as its runtime. Released under the MIT License; see [LICENSE](LICENSE).
