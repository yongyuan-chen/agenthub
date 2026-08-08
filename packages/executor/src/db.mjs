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
      INSERT INTO local_tasks (task_id, title, spec, status, session_id, dir, repo_url, base_branch, branch_name, permission_mode, lease, cost_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET title=excluded.title, spec=excluded.spec, updated_at=excluded.updated_at
    `).run(t.taskId, t.title ?? '', t.spec ?? '', t.status ?? 'queued', t.sessionId ?? null,
      t.dir ?? null, t.repoUrl ?? null, t.baseBranch ?? 'main', t.branchName ?? null,
      t.permissionMode ?? 'default', t.lease ?? 'daemon', t.costUsd ?? 0, now, now);
  }

  patchTask(taskId, fields) {
    const map = {
      status: 'status', sessionId: 'session_id', dir: 'dir', branchName: 'branch_name',
      lease: 'lease', costUsd: 'cost_usd', pendingRequest: 'pending_request', lastError: 'last_error',
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
