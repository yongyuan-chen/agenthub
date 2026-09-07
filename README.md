# AgentHub

A self-hosted hub for AI coding agents: the agents live on your own machines, and you reach them from any device (browser or phone) through Cloudflare — a task board plus structured chat panes instead of a terminal and a scatter of chat windows.

```
phone/browser ──HTTPS/WS──► Cloudflare Worker (board frontend + API + Hub DO + D1 + Web Push)
                              ▲
                              │ outbound WebSocket only (zero inbound ports)
                    executor daemon (one per machine)
                    ├─ drives the claude CLI (bidirectional stream-json, via your API relay)
                    └─ drives the codex CLI (app-server JSON-RPC, via your API relay)
```

The board, approvals, reconnect/reconciliation, diffs, push notifications and scheduled tasks are the same for both agents — every difference is contained in the executor's session adapter layer.

## Deploy (one command)

Prerequisites: Node ≥ 22 and git installed locally, plus the claude CLI and/or the codex CLI (whichever you install is what you can run — a node reports its installed backends during the handshake); `deploy/.env` filled in with your Cloudflare token (that file is gitignored).

```bash
bash deploy/setup-all.sh
```

The script runs, in order: build the frontend → create D1 and its tables → deploy the Worker to `agenthub.win` (falling back to workers.dev automatically if the token lacks zone permissions) → walk you through creating an admin account → register this machine as an execution node → write `~/.agenthub/executor.config.json` → install the launchd/systemd service → verify the node is online, and finally print **the site URL and the admin credentials**.

Open that URL on your phone → sign in as admin → save your model relay's Base URL / API Key once under Settings (after that it is pushed automatically to every node on your account, so new nodes never need it again) → "Add to Home Screen" is recommended, and tap 🔔 to enable push.

### Adding more servers (M3)

Clone this repo on the new machine, then sign in to the web UI to get a session token (or just copy the ready-made one-liner from the "Add node" dialog, which already has the token baked in):

```bash
APP_URL=https://agenthub.win USER_TOKEN=<your session token> \
bash deploy/setup-node.sh my-h100-box
```

No relay URL or API key needed — as long as this server belongs to the same account as the first one, the model config you saved after signing in syncs over automatically.

### Upgrading

Nodes report their protocol version during the handshake. **A node on an outdated protocol version is explicitly marked undispatchable** (creating a task against it fails with a message telling you to upgrade) rather than silently doing the wrong thing after receiving fields it doesn't understand. Upgrade order: **all executor nodes first, then deploy the worker**.

## Usage

- **Create a task**: title + task description (the first prompt) + pick a node, optionally a repo (auto `clone` + `git worktree add -b task/<id>`).
- **Picking a backend = picking a model profile**: a profile pins both "which agent CLI" and "which relay", so "switch model" is also "switch backend". A card that already has a session cannot switch backends (session IDs are not interchangeable between them); the server rejects it outright.
- **State machine**: `queued → starting → running → waiting_human ⇄ running → review → done`; plus `failed`, `unknown` when a node goes missing, and cancellable at any time.
- **Approval flow**: when an agent wants to run an unauthorized Bash command or similar, the task enters "waiting for decision", your phone gets a push, and you tap allow/deny (auto-denied after a 4-hour timeout).
- **Review**: a full diff is generated after every turn (the "Changes" tab); you can keep the conversation going or mark it done. Each card continuously shows accumulated reference cost — AgentHub never cuts a conversation off based on turn count or accumulated cost.
- **IDE handoff**: task detail → "Info" → "Take over in IDE", and the executor pastes **the complete command for that specific node** into the conversation (the isolated directory in it is known only to the node itself): for claude, `CLAUDE_CONFIG_DIR=<workRoot>/claude-config claude --resume <session_id>`; for codex, `CODEX_HOME=<workRoot>/codex-home codex resume <session_id>`. Neither environment variable **can be omitted** — without it the CLI looks in `~/.claude` / `~/.codex` and reports that the session does not exist. Your IDE needs the relay configured too. Click "Hand back" when you're done.
- **Scheduled tasks**: on the claude side, `.claude/scheduled_tasks.json` in the task directory is scanned (created by the agent itself via CronCreate, 5-field cron); on the codex side, `CODEX_HOME/automations/*/automation.toml` (RRULE) is scanned and dispatched to the card matching its `target_thread_id` — which means **an automation you created in the Codex desktop app runs on your server without the app being open**, with results pushed to your phone. The two sides never cross over.
- **Offline**: while an executor is offline, tasks keep running and events queue locally (outbox), then reconcile idempotently by seq on reconnect; a node is marked offline after a 60s heartbeat timeout, with a push notification.

## Codex backend notes

- **Your relay must support `POST /v1/responses`.** Codex only has `wire_api = "responses"` left (`chat` was removed upstream), so a relay that works for claude will not necessarily work for Codex. The frontend warns about this when you create a Codex profile.
- **A Codex profile cannot be the account default.** The default profile is the relay used by cards that have no profile pinned, and those cards all run claude; making a Codex profile the default would fail all of them at once, so the server returns 409. The account's first **claude** profile automatically becomes the default.
- **Verified against codex `0.144.6`.** `codex app-server` is marked `[experimental]` upstream, so if Codex cards stop starting after a codex upgrade, check `~/agenthub/logs/executor.log` for handshake errors first.
- Codex does not report dollar cost (only tokens), so a Codex card's "cost" shows usage rather than an amount — that is not a bug, it just doesn't make numbers up. The auto-compaction threshold uses the context window Codex reports about itself, which is more accurate than the fixed constant used on the claude side.

## Repository layout

```
packages/shared/     protocol constants, state machine, ulid (shared front/back, zero deps)
packages/executor/   the resident daemon: node:sqlite local source of truth + outbox,
                     worktree management, and two backends:
                     session.mjs / sessions.mjs      claude CLI (bidirectional stream-json + can_use_tool)
                     codex-session.mjs               codex app-server (JSON-RPC)
                     codex-sessions.mjs              codex rollout jsonl reader (incremental tailing
                                                     when no process is live)
                     codex-automations.mjs           automation.toml + an RRULE subset
                     backends.mjs                    backend adapter table for the persistence/transcript layer
packages/worker/     Cloudflare Worker: routing/auth + Hub DO (WS hibernation, event absorption,
                     heartbeat alarm, reconciliation) + D1 schema + Web Push (RFC 8291/8292 via WebCrypto)
packages/web/        React 19 board frontend, built with esbuild, served directly as Worker assets
deploy/              one-command deploy / add-machine scripts, launchd/systemd templates, VAPID generation
tests/               unit tests + in-process integration tests (real executor modules ↔ real hub-core,
                     fake WS / fake D1)
```

## Consistency model (implementation notes)

**The execution site is the source of truth locally; the cloud is the source of truth for the global view. On reconnect, local overwrites the cloud.**

- Every executor event is written to the local outbox first (`(task_id, seq)`, monotonically increasing) and only then reported; the cloud absorbs it idempotently by `(task_id, seq)` with `INSERT OR IGNORE` and acks.
- On reconnect the executor reports `{status, lastSeq}` per task, the DO corrects D1 to match the executor, and asks the executor to resend everything after `lastSeq`.
- Task-level fields (status/session/cost) only ever move forward by seq, so replayed and live events interleaving cannot roll a state backwards.

## Tests

```bash
npm test             # unit + integration (no network, no cost: fake subprocess + fake WS + fake D1)
npm run smoke        # real claude CLI + relay; exercises tool calls, the approval route, resume
npm run smoke:codex  # real codex + relay; exercises tool calls, the approval route, compact, resume
```

Both smoke tests burn real quota, so they are not part of `npm test` and must be run manually. `smoke:codex`
needs its relay specified separately (a node's default profile is a claude profile):
`CODEX_SMOKE_BASE_URL=... CODEX_SMOKE_API_KEY=... npm run smoke:codex`.

## Security

- Zero inbound ports on the server. Three kinds of credentials are kept separate: the user access token (frontend), the node token (per node, stored hashed, rotatable), and the relay API key (which exists only in each node's local config and never passes through Cloudflare).
- The default permission mode is `acceptEdits` (edits applied automatically, Bash requires human approval); `bypassPermissions` must be chosen explicitly at card creation and carries a red warning. On the Codex side this maps onto `approvalPolicy`/`sandbox`: `acceptEdits → on-request / workspace-write`, `default → untrusted / workspace-write`, `bypassPermissions → never / danger-full-access`.
- Agent output is rendered through an allowlist sanitizer to prevent injection.

## Troubleshooting

```bash
tail -f ~/agenthub/logs/executor.log        # executor log (macOS)
launchctl kickstart -k gui/$UID/com.agenthub.executor   # restart the daemon
npx wrangler tail --config packages/worker/wrangler.generated.jsonc  # live worker logs
```
