import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { CATEGORY_PRESETS } from '../domain/categoryPresets.js';
import { provisionUser, type ProvisionInput } from './provisionUser.js';
import { seedLedgersWithoutCategories } from './seedCategories.js';

const NOW = new Date('2026-09-29T10:00:00Z');
const BOOT = new Date('2026-09-30T10:00:00Z');
const INIT_SQL = fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url));

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'expenses-migrations-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A database as Plan 0001 left it: one user, one personal ledger, two expenses, no categories.
function plan0001Database(): void {
  copyFileSync(INIT_SQL, join(dir, '0001_init.sql'));
  expect(runMigrations(db, NOW, dir)).toEqual(['0001']);
  db.exec(`
    INSERT INTO users (id, timezone, created_at) VALUES ('u1', 'Europe/Belgrade', 't');
    INSERT INTO ledgers (id, kind, name, default_currency, owner_user_id, created_at)
      VALUES ('l1', 'personal', 'Personal', 'RSD', 'u1', 't');
    INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('l1', 'u1', 'owner');
    INSERT INTO expenses (id, ledger_id, created_by, amount_minor, currency, description,
                          occurred_at, occurred_on, source_key, created_at)
      VALUES ('e1', 'l1', 'u1', 100, 'RSD', 'a', 't', '2026-09-01', 'k1', 't'),
             ('e2', 'l1', 'u1', 200, 'RSD', 'b', 't', '2026-09-02', 'k2', 't');
  `);
}

function presetKeys(ledgerId: string): unknown[] {
  return db
    .prepare('SELECT preset_key FROM categories WHERE ledger_id = ? ORDER BY preset_key')
    .pluck()
    .all(ledgerId);
}

const ALL_PRESET_KEYS = CATEGORY_PRESETS.map((p) => p.key).sort();

describe('migration 0002 over a Plan 0001 database', () => {
  it('keeps category_id NULL on every existing expense', () => {
    plan0001Database();
    const before = db.prepare('SELECT COUNT(*) FROM expenses').pluck().get();

    expect(runMigrations(db, BOOT)).toEqual(['0002']);

    expect(before).toBe(2);
    expect(
      db.prepare('SELECT COUNT(*) FROM expenses WHERE category_id IS NULL').pluck().get(),
    ).toBe(2);
  });
});

describe('boot seeding', () => {
  it('gives a ledger with no categories one per preset, and a second run adds nothing', () => {
    plan0001Database();
    runMigrations(db, BOOT);

    expect(seedLedgersWithoutCategories(db, BOOT)).toEqual(['l1']);
    expect(presetKeys('l1')).toEqual(ALL_PRESET_KEYS);
    expect(seedLedgersWithoutCategories(db, BOOT)).toEqual([]);
    expect(presetKeys('l1')).toEqual(ALL_PRESET_KEYS);
    expect(
      db.prepare('SELECT COUNT(*) FROM expenses WHERE category_id IS NULL').pluck().get(),
    ).toBe(2);
  });
});

describe('provisioning seeds the personal ledger', () => {
  const input: ProvisionInput = {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  };

  it('with one category per preset, named from the preset, once', () => {
    runMigrations(db, NOW);
    let n = 0;
    const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

    const { ledger } = provisionUser({ db, newId }, input);
    provisionUser({ db, newId }, input);

    expect(presetKeys(ledger.id)).toEqual(ALL_PRESET_KEYS);
    expect(db.prepare('SELECT preset_key, name FROM categories ORDER BY id').all()).toEqual(
      CATEGORY_PRESETS.map((p) => ({ preset_key: p.key, name: p.name })),
    );
    expect(seedLedgersWithoutCategories(db, BOOT)).toEqual([]);
  });
});
