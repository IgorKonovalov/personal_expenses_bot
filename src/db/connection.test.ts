import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';

const BOOT = new Date('2026-09-29T10:00:00Z');
let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'expenses-db-'));
  return join(dir, 'nested', 'bot.sqlite');
}

describe('openDatabase', () => {
  it('creates the directory and sets WAL, busy_timeout and foreign keys', () => {
    const db = openDatabase(tempDbPath());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('runMigrations', () => {
  it('applies each migration once and records it; a second boot applies nothing', () => {
    const path = tempDbPath();

    const first = openDatabase(path);
    expect(runMigrations(first, BOOT)).toEqual(['0001', '0002', '0003', '0004']);
    first.close();

    const second = openDatabase(path);
    expect(runMigrations(second, BOOT)).toEqual([]);
    expect(second.prepare('SELECT version, applied_at FROM schema_migrations').all()).toEqual([
      { version: '0001', applied_at: '2026-09-29T10:00:00.000Z' },
      { version: '0002', applied_at: '2026-09-29T10:00:00.000Z' },
      { version: '0003', applied_at: '2026-09-29T10:00:00.000Z' },
      { version: '0004', applied_at: '2026-09-29T10:00:00.000Z' },
    ]);
    second.close();
  });
});
