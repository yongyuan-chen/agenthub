-- AgentHub D1 schema (idempotent)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  api_base_url TEXT,
  api_key TEXT,
  api_model TEXT DEFAULT 'gpt-5.6',
  default_repo_url TEXT,
  open_panes TEXT,
  last_model_profile_id TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Small generic key/value store for admin-toggleable app-wide flags
-- (e.g. registration_open). Avoids env-var/redeploy round-trips for
-- settings an admin should be able to flip from the web UI.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- team_id: legacy single-team column, superseded by the node_teams join
-- table further down (same story as tasks.team_id/task_teams) — kept in
-- place, unused, rather than dropped. A node can now belong to several
-- projects at once, same as tasks.
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  owner_user_id TEXT,
  team_id TEXT,
  labels TEXT DEFAULT '[]',
  status TEXT DEFAULT 'offline',
  last_heartbeat_at INTEGER,
  created_at INTEGER,
  name TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_team ON nodes(team_id);

-- What a node told us it can do, refreshed on every hello. Side table for the
-- same idempotent-redeploy reason as model_profile_backends above.
-- No row = a node that hasn't reconnected since the upgrade: treated as
-- protocol_version 1 (claude only, and not dispatchable at all, since the
-- anthropic->provider rename has no compatibility layer and such a node would
-- silently ignore a pinned model profile rather than reject it).
CREATE TABLE IF NOT EXISTS node_capabilities (
  node_id          TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  backends         TEXT NOT NULL DEFAULT '["claude"]',
  updated_at       INTEGER
);

-- Fine-grained capabilities a node reports in `hello`, for changes an older
-- node handles safely but partially (protocol_version above is the hard gate
-- for the ones it can't handle at all). Side table for the same
-- idempotent-redeploy reason as node_capabilities itself. No row = a node
-- that hasn't reconnected since this shipped: assumed to support nothing
-- here, which is always the conservative choice.
CREATE TABLE IF NOT EXISTS node_features (
  node_id    TEXT PRIMARY KEY,
  features   TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  repo_url TEXT,
  base_branch TEXT DEFAULT 'main',
  node_id TEXT,
  owner_user_id TEXT,
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  branch_name TEXT,
  permission_mode TEXT DEFAULT 'bypassPermissions',
  lease TEXT DEFAULT 'daemon',
  cost_usd REAL DEFAULT 0,
  context_tokens INTEGER,
  last_seq INTEGER DEFAULT 0,
  pending_request TEXT,
  last_error TEXT,
  archived_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  -- Deliberately separate from permission_mode: bypassPermissions is a CLI
  -- startup flag claude itself still overrides for a small set of hard-coded
  -- safety confirmations (e.g. rm-pattern commands) that no mode can skip.
  -- This flag makes the *executor* auto-decide 'allow' for those specific
  -- requests too, without ever surfacing them to a human — an explicit,
  -- separately-confirmed opt-in (see task.jsx's decision-card note) since it
  -- switches off the one guardrail Anthropic deliberately kept mode-proof.
  auto_decide_all INTEGER DEFAULT 0,
  -- Which model profile this task is pinned to (model_profiles.id), null =
  -- the node-shared default config from the owner's Settings. The resolved
  -- {baseUrl, apiKey, model} lives executor-side (provider_override);
  -- cloud keeps only the profile reference so the frontend can display the
  -- current model and offer switching without credentials ever appearing in
  -- a GET /tasks response. Spawn-time env (like permission_mode): a switch
  -- takes effect from the next turn's spawn, not mid-generation.
  model_profile_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, seq);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  subscription TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subscriptions(owner_user_id);

-- Server-side recent-path history so path pickers stay in sync across
-- devices/browsers instead of relying on local storage.
CREATE TABLE IF NOT EXISTS recent_repos (
  owner_user_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (owner_user_id, repo_url)
);
CREATE INDEX IF NOT EXISTS idx_recent_repos_owner ON recent_repos(owner_user_id, last_used_at DESC);

-- Named model/relay profiles a user can pick per new chat. is_default marks
-- the one profile whose values are mirrored into users.api_base_url/api_key/
-- api_model (see hub-core.mjs's set-default route) — that mirror is what
-- actually gets auto-pushed to nodes; is_default itself is purely a UI
-- concept for "which profile does that copy currently represent."
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT,
  model TEXT,
  is_default INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_profiles_owner ON model_profiles(owner_user_id);

-- Which agent CLI a profile drives ('claude' | 'codex'); no row = 'claude',
-- which is what every profile predating dual-backend support is.
-- A side table rather than a model_profiles column on purpose: this whole file
-- is re-executed verbatim by deploy/setup-all.sh on every deploy, so it has to
-- stay fully idempotent. CREATE TABLE IF NOT EXISTS is; a bare
-- ALTER TABLE ... ADD COLUMN is not — it would abort the deploy script on the
-- second run and take every subsequent deploy with it. Same reason
-- conversation_claims_v2 / task_teams / node_teams exist as side tables.
CREATE TABLE IF NOT EXISTS model_profile_backends (
  profile_id TEXT PRIMARY KEY,
  backend    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_cmds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_node ON pending_cmds(node_id, id);

-- Immutable claim for newly-adopted external Claude Code histories. Existing
-- legacy duplicate task/session rows are intentionally not backfilled; every
-- new adoption path claims here first, without requiring a unique index on the
-- already-dirty tasks table.
CREATE TABLE IF NOT EXISTS conversation_claims (
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE,
  source_cwd TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, session_id)
);

CREATE TABLE IF NOT EXISTS conversation_claims_v2 (
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_cwd TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE,
  immutable INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, session_id, source_cwd)
);

CREATE TABLE IF NOT EXISTS conversation_source_cache (
  source_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_cwd TEXT NOT NULL,
  preview TEXT,
  mtime INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_cache_expiry ON conversation_source_cache(expires_at);

CREATE TABLE IF NOT EXISTS conversation_history_cursors (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  before_offset INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_cursor_expiry ON conversation_history_cursors(expires_at);

CREATE TABLE IF NOT EXISTS conversation_history_cursors_v2 (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  before_offset INTEGER NOT NULL,
  boundary_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_mtime REAL NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (source_id, before_offset)
);
CREATE INDEX IF NOT EXISTS idx_history_cursor_v2_expiry ON conversation_history_cursors_v2(expires_at);

CREATE TABLE IF NOT EXISTS conversation_history_cursors_v3 (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  before_offset INTEGER NOT NULL,
  boundary_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_mtime REAL NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (source_id, before_offset)
);
CREATE INDEX IF NOT EXISTS idx_history_cursor_v3_expiry ON conversation_history_cursors_v3(expires_at);

CREATE TABLE IF NOT EXISTS durable_cmds (
  command_key TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_durable_cmds_node ON durable_cmds(node_id, created_at);

-- A user's chat send, persisted the moment the API accepts it and kept until
-- the node echoes the message back as its own event. This exists because
-- "the WebSocket send() didn't throw" is not delivery: a half-open socket
-- (see cloudlink.mjs's heartbeat watchdog comment — one sat "connected" for
-- 15+ minutes with nothing arriving) accepts writes into the void, so a
-- message could be POSTed successfully, never reach the executor, and never
-- exist anywhere — reported live by a project member as a message that
-- "直接永久消失" after sending. Rows here are what make an accepted send
-- durable, replayable on reconnect, visible on every device while still in
-- flight, and idempotent (same client_message_id -> same row, never a
-- second bubble).
--
-- Deliberately not queued through durable_cmds as well: that table's ack
-- means "the node wrote the command down", which is weaker than the signal
-- used here ("the node put the message in the conversation"), and having two
-- queues for one send is how it would get delivered twice.
CREATE TABLE IF NOT EXISTS outbound_messages (
  task_id           TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  sender_user_id    TEXT,
  payload           TEXT NOT NULL,   -- {text, images} exactly as dispatched
  state             TEXT NOT NULL DEFAULT 'pending', -- pending | failed (delivered rows are deleted)
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (task_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_node ON outbound_messages(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_task ON outbound_messages(task_id, created_at);

-- Admin-managed team sharing: an admin creates teams and adds members. A
-- task/node explicitly bound to a team (see tasks.team_id / nodes.team_id
-- above) is visible to every member of that team; task *actions* still stay
-- creator-only regardless of team — see the "design decisions" note in the
-- team-sharing plan for why this is a deliberate, not accidental, choice.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- A conversation can belong to several teams/projects at once (superseding
-- tasks.team_id, which is now unused — left in place rather than dropped,
-- zero risk either way). No row for a task = personal (visible only to its
-- owner); one or more rows = visible to every member of each listed team,
-- and no longer shown in the owner's personal view (same exclusivity rule
-- as before, just generalized from "one optional team" to "a set").
CREATE TABLE IF NOT EXISTS task_teams (
  task_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (task_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_task_teams_team ON task_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_task_teams_task ON task_teams(task_id);

-- Same story as task_teams, for nodes — a node can be registered/shared into
-- several projects at once instead of at most one.
CREATE TABLE IF NOT EXISTS node_teams (
  node_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (node_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_node_teams_team ON node_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_node_teams_node ON node_teams(node_id);

-- Per-task run/attention timestamps. A side table for the same reason as
-- task_teams above: this file is re-executed verbatim on every deploy, so
-- adding columns to tasks with ALTER TABLE would break the second deploy.
--   run_started_at: when the *current* turn began (transition into
--     running/starting from anything else) — the live "已运行 12m03s" timer
--     reads this. Deliberately not tasks.updated_at: cost/usage events bump
--     that mid-turn, which would reset the timer every few seconds.
--   attention_at: when the agent last stopped and needed a human (turn
--     finished / failed / waiting on a decision) — exactly the transitions
--     that already send a push. Compared against task_reads.seen_at to
--     decide whether a conversation is "unread".
CREATE TABLE IF NOT EXISTS task_activity (
  task_id TEXT PRIMARY KEY,
  run_started_at INTEGER,
  attention_at INTEGER
);

-- Per-user read state: a project conversation is visible to every member, so
-- "seen" can't live on the task row — each member clears their own dot by
-- looking at the conversation. No row = never seen (anything with an
-- attention_at is unread).
CREATE TABLE IF NOT EXISTS task_reads (
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_reads_user ON task_reads(user_id);
