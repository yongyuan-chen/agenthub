-- AgentHub D1 schema (idempotent)
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  labels TEXT DEFAULT '[]',
  status TEXT DEFAULT 'offline',
  last_heartbeat_at INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  repo_url TEXT,
  base_branch TEXT DEFAULT 'main',
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  branch_name TEXT,
  permission_mode TEXT DEFAULT 'acceptEdits',
  lease TEXT DEFAULT 'daemon',
  cost_usd REAL DEFAULT 0,
  last_seq INTEGER DEFAULT 0,
  pending_request TEXT,
  last_error TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

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
  subscription TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pending_cmds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_node ON pending_cmds(node_id, id);
