# JARVIS Dashboard — Hermes v0.22.2 Alignment & Hardening Plan

> Goal: bring the dashboard in line with the Hermes Agent running on this machine
> (v0.22.2), then fix the bugs and dead features found in the audit, in
> priority order. Each phase is independently shippable.

## Status (this session — 10 commits)

- **Phase 1 ✓** stream-json rewrite (tool/usage telemetry, structured session_id, permission, profile)
- **Phase 2 ✓** bug fixes (path-traversal guard, README clone URLs, JSON.parse guard, orphaned-mission reconcile)
- **Phase 3 ✓** security (token-gate /api/status, security headers + CSP, self-hosted fonts, hardened .env parser)
- **Phase 4 ✓** robustness (probe caching, cancel→kill escalation, durable error log, idle-timeout exempts tools)
- **Phase 5 ✓** tests (12 stdlib-unittest cases incl. fake-hermes integration + CI)
- **Phase 6 ~** background preemption ✓, /api/health ✓, a11y label ✓, session persistence ✓
  **Remaining:** config UI, mobile/tablet layout, full history scrollback, launchd agent

## Verified integration facts (Hermes v0.22.2 — do not re-derive)

**Streaming protocol** — `hermes chat --format stream-json` emits NDJSON on stdout:

```json
{"type":"system","subtype":"init","model":"deepseek-v4-pro","session_id":"20261015_141256_740936","timestamp":...}
{"type":"text","text":"ban","timestamp":...}                      // token-level streaming
{"type":"tool_use","name":"terminal","input":{"command":"echo hi"},"timestamp":...}
{"type":"tool_result","name":"terminal","output":"...","duration_ms":1045,"is_error":false,"timestamp":...}
{"type":"result","session_id":"...","exit_code":0,"text":"banana",
 "tokens":{"input":19942,"output":12,"total":19954,"cache_read":0,"cache_write":0},
 "duration_ms":4492,"timestamp":...}
```

- `session_id` is a **first-class field** on `system/init` and `result` — no more
  regex-parsing stderr. (stderr still prints `session_id: ...` + `↻ Resumed session...`
  noise; ignore stderr entirely in stream-json mode.)
- `result.text` is the clean full answer; `text` deltas sum to it but may carry
  leading whitespace.
- `tokens` and `duration_ms` live on `result`.

**Flags verified on v0.22.2:**
- `--format stream-json` (implies `--quiet`), `--query-file -` (reads prompt from
  stdin — documented-safe for arbitrary text), `--resume SID`, `--source TAG`
  (default `cli`; **third-party integrations should use `tool`**), `--yolo`
  (bypass approval), `--model`, `--toolsets`.
- **No `--system` flag** — the persona must ride inside the prompt (current
  approach is correct).
- **`--profile` is NOT a `chat` flag.** It's global: `hermes -p <name> <cmd>`.
  But `HERMES_PROFILE` is a recognized env var (`hermes_cli/config.py`), and the
  subprocess already inherits it — so set `child_env["HERMES_PROFILE"]`, don't
  pass a flag.

## Phases

### Phase 1 — Hermes alignment (runtime.py rewrite)  ← the keystone
- `build_command`: `--format stream-json --query-file -` (stdin), drop `-Q -q`,
  add `--yolo` when `PERMISSION == "bypass"`, remove the invalid `--profile` flag.
- `_run_hermes_locked`: write prompt to stdin; parse NDJSON; emit events:
  `status` → `latency` (first text) → `delta` (text) → `tool` (tool_use/tool_result)
  → `usage` (result.tokens) → `complete` (result: session_id + text + ms).
- This fixes 4 things at once: dead tool/usage telemetry, the session-id capture
  race, the inert `JARVIS_PERMISSION`, and the latent `--profile` crash.

### Phase 2 — Bug fixes
- Path-traversal guard: prefix match → `os.path.commonpath` (or `UI in f.parents`).
- README clone URLs: `Itsme23476/jarvis-hermes-dashboard` → `creativef/jarvis-hermes-dashboard`.
- `app.js`: guard `JSON.parse(line)` per-line; fix dead `sys('session')` (no such
  element); relabel the `usage` log entry.
- Background-mission state leak: mark orphaned `running` missions `failed` on boot.

### Phase 3 — Security hardening
- Token-gate `/api/status` (drop or auth-gate `session`/`workdir`).
- Add `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a CSP.
- Bundle the two Google Fonts locally (kill the phone-home + offline breakage).
- Harden the `.env` parser (inline comments, `export `, value whitespace).

### Phase 4 — Robustness & quality
- Cache `hermes --version` + `hermes tools list` probes with a short TTL (they
  currently run on every request, up to ~32s of subprocess spawn).
- `cancel_active`: escalate `terminate()` → `kill()` after a grace period.
- Durable server-side error log (rotating, `0600`).
- Make `JARVIS_TIMEOUT` adaptive (or clearly document it kills long tool calls).

### Phase 5 — Tests
- `tests/fake_hermes` stub binary (records argv/stdin, replays canned NDJSON) —
  exercises the subprocess machinery without a live model.
- Unit tests: `commands.py` state transactions, `.env` parsing, path guard.
- CI (GitHub Actions): syntax check + pytest.

### Phase 6 — Features (roadmap, after 1–5)
- Background-mission queue (don't block foreground turns) with status/ETA.
- Persistent conversation history (survives restart) + scrollback.
- Config UI instead of hand-editing `.env`.
- launchd/launch-agent for always-on + `/api/health` readiness probe.
- Mobile/tablet responsive layout; a11y (aria-labels, contrast).

## Execution convention
- Work in `~/jarvis-hermes-dashboard`, one commit per phase (or per task).
- Verify each change with `python3 -c "import runtime, server, commands, voice"` +
  a live `./start.sh` smoke test + `curl /api/status`.
- `pytest` after Phase 5 lands.
