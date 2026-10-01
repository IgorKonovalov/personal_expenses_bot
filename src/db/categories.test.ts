import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORY_PRESETS } from '../domain/categoryPresets.js';
import {
  archiveCategory,
  insertCategoriesOrIgnore,
  listActiveCategories,
  listEssentialCategoryIds,
  listLedgersWithoutCategories,
  setCategoryEssential,
} from './categories.js';
import { openDatabase, type Db } from './connection.js';
import { insertLedger, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-09-29T10:00:00Z');
const LATER = new Date('2026-09-30T10:00:00Z');
const USER = 'user-a' as UserId;
const LEDGER_A = 'ledger-a' as LedgerId;
const LEDGER_B = 'ledger-b' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  for (const [id, kind] of [
    [LEDGER_A, 'personal'],
    [LEDGER_B, 'shared'],
  ] as const) {
    insertLedger(db, {
      id,
      kind,
      name: 'Personal',
      defaultCurrency: 'RSD',
      timezone: kind === 'shared' ? 'Europe/Belgrade' : null,
      ownerUserId: USER,
      createdAt: NOW,
    });
  }
});

const cafe = { name: 'Кафе', nameKey: 'кафе', presetKey: 'cafe' };
const other = { name: 'Другое', nameKey: 'другое', presetKey: 'other' };

describe('categories repository', () => {
  it('skips a category whose name key or preset key the ledger already has', () => {
    expect(insertCategoriesOrIgnore(db, LEDGER_A, [cafe, other], NOW)).toBe(2);
    expect(
      insertCategoriesOrIgnore(
        db,
        LEDGER_A,
        [
          { name: 'КАФЕ', nameKey: 'кафе', presetKey: null },
          { name: 'Прочее', nameKey: 'прочее', presetKey: 'other' },
        ],
        NOW,
      ),
    ).toBe(0);
    expect(insertCategoriesOrIgnore(db, LEDGER_B, [cafe], NOW)).toBe(1);

    expect(listActiveCategories(db, LEDGER_A).map((c) => [c.name, c.presetKey])).toEqual([
      ['Кафе', 'cafe'],
      ['Другое', 'other'],
    ]);
  });

  it('lists ledgers with no category at all', () => {
    insertCategoriesOrIgnore(db, LEDGER_A, [cafe], NOW);

    expect(listLedgersWithoutCategories(db)).toEqual([LEDGER_B]);
  });

  it('archives once and drops the category from the active list', () => {
    insertCategoriesOrIgnore(db, LEDGER_A, [cafe, other], NOW);
    const [cafeRow] = listActiveCategories(db, LEDGER_A);
    if (cafeRow === undefined) throw new Error('setup failed');

    expect(archiveCategory(db, cafeRow.id, LATER)).toBe(true);
    expect(archiveCategory(db, cafeRow.id, LATER)).toBe(false);

    expect(listActiveCategories(db, LEDGER_A).map((c) => c.presetKey)).toEqual(['other']);
    expect(
      db.prepare('SELECT archived_at FROM categories WHERE id = ?').pluck().get(cafeRow.id),
    ).toBe('2026-09-30T10:00:00.000Z');
  });

  it('sets essential absolutely and lists essential ids, archived ones included', () => {
    insertCategoriesOrIgnore(db, LEDGER_A, [{ ...cafe, essential: true }, other], NOW);
    const [cafeRow, otherRow] = listActiveCategories(db, LEDGER_A);
    if (cafeRow === undefined || otherRow === undefined) throw new Error('setup failed');
    expect([cafeRow.essential, otherRow.essential]).toEqual([true, false]);

    expect(setCategoryEssential(db, otherRow.id, true)).toBe(true);
    expect(setCategoryEssential(db, otherRow.id, true)).toBe(false);
    archiveCategory(db, cafeRow.id, LATER);

    expect([...listEssentialCategoryIds(db, LEDGER_A)]).toEqual([cafeRow.id, otherRow.id]);
  });
});

describe('migration 0009: essential categories', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('marks the five essential presets of an existing ledger and leaves user categories optional', () => {
    const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const file of readdirSync(migrations).filter((f) => f < '0009')) {
      copyFileSync(join(migrations, file), join(dir, file));
    }
    const old = openDatabase(':memory:');
    runMigrations(old, NOW, dir);
    insertUser(old, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
    insertLedger(old, {
      id: LEDGER_A,
      kind: 'personal',
      name: 'Personal',
      defaultCurrency: 'RSD',
      ownerUserId: USER,
      createdAt: NOW,
    });
    const insert = old.prepare(
      `INSERT INTO categories (ledger_id, name, name_key, preset_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const presets = ['groceries', 'cafe', 'transport', 'housing', 'health', 'clothes', 'fun'];
    for (const key of [...presets, 'telecom', 'gifts', 'other']) {
      insert.run(LEDGER_A, key, key, key, NOW.toISOString());
    }
    insert.run(LEDGER_A, 'Дача', 'дача', null, NOW.toISOString());

    // Later migrations apply after it; only the first one is this test's.
    expect(runMigrations(old, NOW)[0]).toBe('0009');

    const essential = old
      .prepare('SELECT name FROM categories WHERE essential = 1 ORDER BY name')
      .pluck()
      .all();
    expect(essential).toEqual(['groceries', 'health', 'housing', 'telecom', 'transport']);
    expect(old.prepare("SELECT essential FROM categories WHERE name = 'Дача'").pluck().get()).toBe(
      0,
    );
    expect(
      CATEGORY_PRESETS.filter((p) => p.essential)
        .map((p) => p.key)
        .sort(),
    ).toEqual(essential);
  });
});
