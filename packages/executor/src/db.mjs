// Local truth of the execution site. node:sqlite (built into Node >= 22), zero deps.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export class LocalDb {
  constructor(workRoot, file = 'executor.db') {
    this.db = new DatabaseSync(path.join(workRoot, file));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS local_tasks (
        task_id     TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '',
        spec        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'queued',
        session_id  TEXT,
        dir         TEXT,
        repo_url    TEXT,
        base_branch TEXT DEFAULT 'main',
        branch_name TEXT,
        permission_mode TEXT DEFAULT 'default',
        lease       TEXT NOT NULL DEFAULT 'daemon',
        cost_usd    REAL NOT NULL DEFAULT 0,
        pending_request TEXT,
        last_error  TEXT,
        anthropic_override TEXT,
        created_at  INTEGER,
        updated_at  INTEGER
      );
      CREATE TABLE IF NOT EXISTS outbox (
        rowid_pk   INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        acked      INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER,
        UNIQUE(task_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON outbox(acked, rowid_pk);
    `);
    // CREATE TABLE IF NOT EXISTS can't retroactively add a column to an
    // already-existing local_tasks on an already-installed node.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN anthropic_override TEXT'); } catch { /* already exists */ }
    // Transcript line count as of the last time this task's session file was
    // read (IDE-takeover start, or the last resync on IDE-return) — lets a
    // resync pick up only what's new instead of re-reading from scratch.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN synced_lines INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    // Latest per-turn context size estimate (input + cache tokens on the most
    // recent assistant message) — lets the UI warn before a "prompt too
    // long" failure instead of only finding out from the hard error.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN context_tokens INTEGER'); } catch { /* already exists */ }
    // Adopted-from-outside-AgentHub sessions resume directly against the
    // real ~/.claude location instead of an isolated CLAUDE_CONFIG_DIR copy,
    // so VS Code/terminal usage of the same session id never silently
    // diverges from what AgentHub shows — see manager.mjs's startTask()/
    // switchSession() (where this gets set) and _spawn()/userMessage() (where
    // it changes resume behavior).
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN real_config_dir INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN source_cwd TEXT'); } catch { /* already exists */ }
    // Explicit, per-task opt-in to set IS_SANDBOX for the spawned claude CLI
    // — the only way to run bypassPermissions as root, which the CLI
    // otherwise refuses outright. Only ever set via a user's deliberate
    // choice on a specific failed task's retry (see manager.mjs's
    // retryTask()), never a standing default — persisted here (not just a
    // one-shot retry param) because it needs to apply to *every* future
    // spawn of this task, not just the immediate retry.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN allow_root_bypass INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    // Explicit, separately-confirmed opt-in (see task.jsx's decision-card
    // note + confirm() dialog) to auto-decide 'allow' for *every* future
    // permission request on this task, including the ones claude CLI itself
    // forces regardless of permission_mode (e.g. rm-pattern commands) — the
    // one guardrail bypassPermissions deliberately can't skip. Checked first
    // thing in _onPermission(); never a standing default.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN auto_decide_all INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    // Tracks an in-progress auto-retry streak for transient upstream/API
    // errors (see manager.mjs's _scheduleAutoRetry) — retry_attempt counts
    // how many auto-retries have fired since retry_first_failed_at, both
    // reset to 0/null the moment a turn actually succeeds. Persisted (not
    // just an in-memory timer) so a daemon restart mid-streak resumes it
    // instead of silently dropping it — see recover()'s handling.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN retry_first_failed_at INTEGER'); } catch { /* already exists */ }
    // Whatever text was most recently sent to the CLI that hasn't yet gotten
    // a successful response — set right before every send (the creation
    // spec's first send, or any later userMessage), cleared the moment a
    // turn succeeds. _maybeStart() prefers this over `spec` when starting/
    // resuming: `spec` gets consumed (cleared) the first time anything is
    // ever sent, so without this, auto-retrying a turn that failed on its
    // very *first* attempt had nothing left to resend at all — it just
    // resumed into a silently-idle session, never actually retrying.
    // Value is a plain string for a text-only send (unchanged from before
    // image attachments existed), or a JSON-encoded {text, images} string
    // when the send carried attachments — see manager.mjs's encodeInput/
    // decodeInput, which is the only place that (de)serializes this.
    try { this.db.exec('ALTER TABLE local_tasks ADD COLUMN retry_last_input TEXT'); } catch { /* already exists */ }
  }

  getTask(taskId) {
    return this.db.prepare('SELECT * FROM local_tasks WHERE task_id = ?').get(taskId) ?? null;
  }

  allTasks() {
    return this.db.prepare('SELECT * FROM local_tasks').all();
  }

  activeTasks() {
    return this.db.prepare(
      "SELECT * FROM local_tasks WHERE status IN ('queued','starting','running','waiting_human','review')"
    ).all();
  }

  upsertTask(t) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO local_tasks (task_id, title, spec, status, session_id, dir, repo_url, base_branch, branch_name, permission_mode, lease, cost_usd, anthropic_override, real_config_dir, source_cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET title=excluded.title, spec=excluded.spec, updated_at=excluded.updated_at
    `).run(t.taskId, t.title ?? '', t.spec ?? '', t.status ?? 'queued', t.sessionId ?? null,
      t.dir ?? null, t.repoUrl ?? null, t.baseBranch ?? null, t.branchName ?? null,
      t.permissionMode ?? 'default', t.lease ?? 'daemon', t.costUsd ?? 0,
      t.anthropicOverride ? JSON.stringify(t.anthropicOverride) : null, t.realConfigDir ? 1 : 0, t.sourceCwd ?? null, now, now);
  }

  patchTask(taskId, fields) {
    const map = {
      status: 'status', sessionId: 'session_id', dir: 'dir', branchName: 'branch_name',
      lease: 'lease', costUsd: 'cost_usd', pendingRequest: 'pending_request', lastError: 'last_error',
      syncedLines: 'synced_lines', contextTokens: 'context_tokens', realConfigDir: 'real_config_dir',
      permissionMode: 'permission_mode', allowRootBypass: 'allow_root_bypass', autoDecideAll: 'auto_decide_all',
      spec: 'spec', sourceCwd: 'source_cwd', retryAttempt: 'retry_attempt', retryFirstFailedAt: 'retry_first_failed_at',
      retryLastInput: 'retry_last_input', anthropicOverride: 'anthropic_override',
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(Date.now(), taskId);
    this.db.prepare(`UPDATE local_tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...vals);
  }

  nextSeq(taskId) {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM outbox WHERE task_id = ?').get(taskId);
    return (row?.m ?? 0) + 1;
  }

  lastSeq(taskId) {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM outbox WHERE task_id = ?').get(taskId);
    return row?.m ?? 0;
  }

  pushEvent(taskId, ev) {
    const seq = this.nextSeq(taskId);
    this.db.prepare('INSERT INTO outbox (task_id, seq, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, seq, JSON.stringify(ev), Date.now());
    return seq;
  }

  unacked(limit = 500) {
    return this.db.prepare(
      'SELECT task_id, seq, payload FROM outbox WHERE acked = 0 ORDER BY rowid_pk LIMIT ?'
    ).all(limit);
  }

  unackedAfter(taskId, afterSeq, limit = 500) {
    return this.db.prepare(
      'SELECT task_id, seq, payload FROM outbox WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?'
    ).all(taskId, afterSeq, limit);
  }

  ack(taskId, seq) {
    this.db.prepare('UPDATE outbox SET acked = 1 WHERE task_id = ? AND seq <= ?').run(taskId, seq);
  }
}
