import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Applies every `NNNN_*.sql` file not yet recorded in schema_migrations, in filename order,
// each in its own transaction. Forward-only: an applied file is never re-run or edited.
// Returns the versions applied by this call.
export function runMigrations(db: Db, now: Date, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare<[], { version: string }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );
  const record = db.prepare<[string, string]>(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  const pending = readdirSync(dir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .filter((file) => !applied.has(file.slice(0, 4)));

  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file.slice(0, 4), now.toISOString());
    })();
  }
  return pending.map((file) => file.slice(0, 4));
}
