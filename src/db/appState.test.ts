import { beforeEach, describe, expect, it } from 'vitest';
import { getAppState, setAppState } from './appState.js';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, new Date('2026-09-30T10:00:00Z'));
});

describe('app state repository', () => {
  it('has no value for a key never set', () => {
    expect(getAppState(db, 'last_announced_version')).toBeUndefined();
  });

  it('keeps one row per key: a second set replaces the value', () => {
    setAppState(db, 'last_announced_version', '0.3.0');
    setAppState(db, 'last_announced_version', '0.3.1');

    expect(getAppState(db, 'last_announced_version')).toBe('0.3.1');
    expect(db.prepare('SELECT COUNT(*) FROM app_state').pluck().get()).toBe(1);
  });
});
