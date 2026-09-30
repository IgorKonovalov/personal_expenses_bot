import type { Db } from './connection.js';

// Process-wide key/value state, one row per key (ADR-0013).
export type AppStateKey = 'last_announced_version';

export function getAppState(db: Db, key: AppStateKey): string | undefined {
  return db
    .prepare<[string], { value: string }>('SELECT value FROM app_state WHERE key = ?')
    .get(key)?.value;
}

export function setAppState(db: Db, key: AppStateKey, value: string): void {
  db.prepare<[string, string]>(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
