import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase, type Db } from './connection.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from './expenses.js';
import {
  expenseDaysThrough,
  listFxDayFetches,
  rateLookupBetween,
  setFxDay,
  storeFxList,
} from './fxRates.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-09-28T08:00:00Z');
const d = (day: string) => day as LocalDate;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  // The NBS middle rate list of 2026-09-28 (list 184), trimmed.
  storeFxList(
    db,
    {
      listDate: d('2026-09-28'),
      listNumber: 184,
      rates: [
        { currency: 'EUR', unit: 1, middleE4: 1174993 },
        { currency: 'USD', unit: 1, middleE4: 1031782 },
      ],
    },
    NOW,
  );
});

describe('rateLookupBetween', () => {
  it('reads the rate of a day pointed at its list', () => {
    setFxDay(db, d('2026-09-28'), d('2026-09-28'), NOW);
    const rateOf = rateLookupBetween(db, d('2026-09-28'), d('2026-09-28'));
    expect(rateOf('EUR', d('2026-09-28'))).toEqual({ unit: 1, middleE4: 1174993 });
    expect(rateOf('KZT', d('2026-09-28'))).toBeUndefined();
  });

  it('borrows the row 2 days earlier for a day with no row, and none from 5 days earlier', () => {
    setFxDay(db, d('2026-09-28'), d('2026-09-28'), NOW);
    const rateOf = rateLookupBetween(db, d('2026-09-30'), d('2026-10-03'));
    expect(rateOf('USD', d('2026-09-30'))).toEqual({ unit: 1, middleE4: 1031782 });
    expect(rateOf('USD', d('2026-10-03'))).toBeUndefined();
  });

  it('borrows nothing past a nearer row that lacks the currency', () => {
    storeFxList(db, { listDate: d('2026-09-29'), listNumber: 185, rates: [] }, NOW);
    setFxDay(db, d('2026-09-28'), d('2026-09-28'), NOW);
    setFxDay(db, d('2026-09-29'), d('2026-09-29'), NOW);
    const rateOf = rateLookupBetween(db, d('2026-09-30'), d('2026-09-30'));
    expect(rateOf('USD', d('2026-09-30'))).toBeUndefined();
  });
});

describe('storeFxList', () => {
  it('replaces the rates of a list stored again', () => {
    storeFxList(
      db,
      {
        listDate: d('2026-09-28'),
        listNumber: 184,
        rates: [{ currency: 'EUR', unit: 1, middleE4: 1175000 }],
      },
      NOW,
    );
    setFxDay(db, d('2026-09-28'), d('2026-09-28'), NOW);
    const rateOf = rateLookupBetween(db, d('2026-09-28'), d('2026-09-28'));
    expect(rateOf('EUR', d('2026-09-28'))).toEqual({ unit: 1, middleE4: 1175000 });
    expect(rateOf('USD', d('2026-09-28'))).toBeUndefined();
  });
});

describe('listFxDayFetches', () => {
  it('maps each stored day in range to its fetch instant', () => {
    setFxDay(db, d('2026-09-27'), d('2026-09-28'), NOW);
    setFxDay(db, d('2026-09-28'), d('2026-09-28'), new Date('2026-09-29T08:00:00Z'));
    expect(listFxDayFetches(db, d('2026-09-28'), d('2026-09-30'))).toEqual(
      new Map([[d('2026-09-28'), new Date('2026-09-29T08:00:00Z')]]),
    );
  });
});

describe('expenseDaysThrough', () => {
  it('is the distinct occurred_on of non-deleted expenses through today, oldest first', () => {
    expect(expenseDaysThrough(db, d('2026-09-28'))).toEqual([]);
    const user = 'user-a' as UserId;
    const ledger = 'ledger-a' as LedgerId;
    insertUser(db, { id: user, timezone: 'Europe/Belgrade', createdAt: NOW });
    insertLedger(db, {
      id: ledger,
      kind: 'personal',
      name: 'Personal',
      defaultCurrency: 'RSD',
      ownerUserId: user,
      createdAt: NOW,
    });
    insertMember(db, { ledgerId: ledger, userId: user, role: 'owner' });
    for (const [n, day] of [
      [1, '2026-09-20'],
      [2, '2026-09-28'],
      [3, '2026-09-26'],
      [4, '2026-09-26'],
      [5, '2026-09-29'],
    ] as const) {
      insertExpenseOrGetExisting(db, {
        id: `expense-${n}` as ExpenseId,
        ledgerId: ledger,
        createdBy: user,
        amountMinor: 45000,
        currency: 'RSD',
        description: 'кофе',
        occurredAt: NOW,
        occurredOn: d(day),
        sourceKey: `test:${n}`,
        createdAt: NOW,
      });
    }
    softDeleteExpense(db, 'expense-1' as ExpenseId, NOW);
    expect(expenseDaysThrough(db, d('2026-09-28'))).toEqual(['2026-09-26', '2026-09-28']);
  });
});
