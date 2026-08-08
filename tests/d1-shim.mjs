// Wrap node:sqlite so hub-core sees the same interface D1 exposes.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export function makeD1(schemaPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const norm = params.map(p => p === undefined ? null : p);
          return {
            async run() {
              const st = db.prepare(sql);
              const info = st.run(...norm);
              return { meta: { changes: Number(info.changes) } };
            },
            async first() {
              return db.prepare(sql).get(...norm) ?? null;
            },
            async all() {
              return { results: db.prepare(sql).all(...norm) };
            },
          };
        },
      };
    },
  };
}
