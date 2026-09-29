import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

// Opens (creating if needed) the SQLite file with the pragmas every connection needs.
// `:memory:` is accepted for tests.
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // Per connection: SQLite ships with foreign keys off.
  db.pragma('foreign_keys = ON');
  return db;
}
