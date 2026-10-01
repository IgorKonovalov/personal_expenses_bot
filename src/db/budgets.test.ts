import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCategoryCap,
  deleteLedgerCaps,
  ensureLedgerBudget,
  findLedgerBudget,
  listLedgerCaps,
  setBudgetLimit,
  setCategoryCap,
} from './budgets.js';
import { archiveCategory, insertCategoriesOrIgnore, listActiveCategories } from './categories.js';
import { openDatabase, type Db } from './connection.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T09:00:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Moscow', createdAt: NOW });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RUB',
    ownerUserId: USER,
    createdAt: NOW,
  });
  insertMember(db, { ledgerId: LEDGER, userId: USER, role: 'owner' });
});

describe('ledger budgets', () => {
  it('creates the budget on the first limit with start day 1 and scope all', () => {
    expect(findLedgerBudget(db, LEDGER)).toBeUndefined();
    expect(setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW)).toBe(true);
    expect(findLedgerBudget(db, LEDGER)).toEqual({
      ledgerId: LEDGER,
      limitMinor: 3_000_000,
      currency: 'RUB',
      scope: 'all',
      periodStartDay: 1,
    });
  });

  it('writes nothing for the same limit again, and adopts a new currency with a new limit', () => {
    setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW);
    expect(setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW)).toBe(false);
    expect(setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'EUR' }, NOW)).toBe(true);
    expect(findLedgerBudget(db, LEDGER)?.currency).toBe('EUR');
  });

  it('sets, re-sets and clears a cap, and lists only active categories', () => {
    insertCategoriesOrIgnore(
      db,
      LEDGER,
      [
        { name: 'Кафе', nameKey: 'кафе', presetKey: 'cafe' },
        { name: 'Подарки', nameKey: 'подарки', presetKey: 'gifts' },
      ],
      NOW,
    );
    const [cafe, gifts] = listActiveCategories(db, LEDGER);
    if (cafe === undefined || gifts === undefined) throw new Error('setup failed');

    expect(setCategoryCap(db, cafe.id, 500_000, NOW)).toBe(true);
    expect(setCategoryCap(db, cafe.id, 500_000, NOW)).toBe(false);
    expect(setCategoryCap(db, gifts.id, 100_000, NOW)).toBe(true);
    archiveCategory(db, gifts.id, NOW);

    expect(listLedgerCaps(db, LEDGER)).toEqual([
      { categoryId: cafe.id, name: 'Кафе', capMinor: 500_000 },
    ]);
    expect(clearCategoryCap(db, cafe.id)).toBe(true);
    expect(clearCategoryCap(db, cafe.id)).toBe(false);
    expect(listLedgerCaps(db, LEDGER)).toEqual([]);
  });

  it("deletes the ledger's caps, archived ones too, and leaves another ledger's", () => {
    const OTHER = 'ledger-b' as LedgerId;
    const OTHER_USER = 'user-b' as UserId;
    insertUser(db, { id: OTHER_USER, timezone: 'Europe/Moscow', createdAt: NOW });
    insertLedger(db, {
      id: OTHER,
      kind: 'personal',
      name: 'Other',
      defaultCurrency: 'RUB',
      ownerUserId: OTHER_USER,
      createdAt: NOW,
    });
    const categories = [
      { name: 'Кафе', nameKey: 'кафе', presetKey: 'cafe' },
      { name: 'Подарки', nameKey: 'подарки', presetKey: 'gifts' },
    ];
    insertCategoriesOrIgnore(db, LEDGER, categories, NOW);
    insertCategoriesOrIgnore(db, OTHER, categories, NOW);
    const [cafe, gifts] = listActiveCategories(db, LEDGER);
    const [otherCafe] = listActiveCategories(db, OTHER);
    if (cafe === undefined || gifts === undefined || otherCafe === undefined) {
      throw new Error('setup failed');
    }
    setCategoryCap(db, cafe.id, 500_000, NOW);
    setCategoryCap(db, gifts.id, 100_000, NOW);
    archiveCategory(db, gifts.id, NOW);
    setCategoryCap(db, otherCafe.id, 300_000, NOW);

    expect(deleteLedgerCaps(db, LEDGER)).toBe(2);
    expect(deleteLedgerCaps(db, LEDGER)).toBe(0);
    expect(listLedgerCaps(db, OTHER)).toEqual([
      { categoryId: otherCafe.id, name: 'Кафе', capMinor: 300_000 },
    ]);
  });

  it('ensures a budget without a limit once, keeping an existing one', () => {
    expect(ensureLedgerBudget(db, LEDGER, 'RUB', NOW)).toBe(true);
    expect(findLedgerBudget(db, LEDGER)?.limitMinor).toBeNull();
    setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW);
    expect(ensureLedgerBudget(db, LEDGER, 'EUR', NOW)).toBe(false);
    expect(findLedgerBudget(db, LEDGER)).toMatchObject({ limitMinor: 3_000_000, currency: 'RUB' });
  });

  it('refuses a limit that is not positive', () => {
    expect(() => setBudgetLimit(db, LEDGER, { limitMinor: 0, currency: 'RUB' }, NOW)).toThrow();
  });
});
