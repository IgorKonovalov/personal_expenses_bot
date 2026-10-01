import { beforeEach, describe, expect, it } from 'vitest';
import {
  archiveCategory,
  insertCategoriesOrIgnore,
  listActiveCategories,
  listLedgersWithoutCategories,
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
});
