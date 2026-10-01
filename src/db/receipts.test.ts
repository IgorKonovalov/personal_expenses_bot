import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { insertCategoriesOrIgnore, listActiveCategories, type CategoryId } from './categories.js';
import { openDatabase, type Db } from './connection.js';
import {
  insertExpenseOrGetExisting,
  setExpenseCategory,
  softDeleteExpense,
  type ExpenseId,
} from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import {
  findMerchantCategory,
  findReceiptByExpense,
  insertReceipt,
  type ReceiptId,
} from './receipts.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;

let db: Db;
let food: CategoryId;
let other: CategoryId;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: USER,
    createdAt: NOW,
  });
  insertMember(db, { ledgerId: LEDGER, userId: USER, role: 'owner' });
  insertCategoriesOrIgnore(
    db,
    LEDGER,
    [
      { name: 'Продукты', nameKey: 'продукты', presetKey: 'groceries' },
      { name: 'Другое', nameKey: 'другое', presetKey: 'other' },
    ],
    NOW,
  );
  const categories = listActiveCategories(db, LEDGER);
  const byPreset = (key: string) => {
    const category = categories.find((c) => c.presetKey === key);
    if (category === undefined) throw new Error(`no ${key} category`);
    return category.id;
  };
  food = byPreset('groceries');
  other = byPreset('other');
});

function addReceipt(n: number, merchantKey: string, categoryId: CategoryId, createdAt = NOW) {
  const expenseId = `expense-${n}` as ExpenseId;
  insertExpenseOrGetExisting(db, {
    id: expenseId,
    ledgerId: LEDGER,
    createdBy: USER,
    amountMinor: 82912,
    currency: 'RSD',
    description: 'Чек',
    occurredAt: createdAt,
    occurredOn: '2026-10-01' as LocalDate,
    sourceKey: `rcpt:RS:fiscal-${n}:${LEDGER}`,
    createdAt,
    categoryId,
  });
  insertReceipt(db, {
    id: `receipt-${n}` as ReceiptId,
    expenseId,
    country: 'RS',
    fiscalId: `fiscal-${n}`,
    merchantKey,
    verifyUrl: 'https://suf.purs.gov.rs/v/?vl=synthetic',
    issuedAt: new Date('2026-09-30T22:30:00Z'),
    createdAt,
  });
  return expenseId;
}

describe('receipts', () => {
  it('stores a new receipt as pending, due at once, with no attempts', () => {
    const expenseId = addReceipt(1, 'rs:AAAA1111', other);

    expect(findReceiptByExpense(db, expenseId)).toEqual({
      id: 'receipt-1',
      expenseId,
      country: 'RS',
      fiscalId: 'fiscal-1',
      merchantKey: 'rs:AAAA1111',
      verifyUrl: 'https://suf.purs.gov.rs/v/?vl=synthetic',
      issuedAt: new Date('2026-09-30T22:30:00Z'),
      sellerName: null,
      fetchState: 'pending',
      attempts: 0,
      nextFetchAt: NOW,
      card: null,
      createdAt: NOW,
    });
  });

  it('finds no merchant category in a ledger without receipts from that shop', () => {
    addReceipt(1, 'rs:BBBB2222', food);

    expect(findMerchantCategory(db, LEDGER, 'rs:AAAA1111')).toBeUndefined();
  });

  it("takes the category of the shop's most recently categorised live receipt", () => {
    const first = addReceipt(1, 'rs:AAAA1111', other, new Date('2026-09-01T10:00:00Z'));
    addReceipt(2, 'rs:AAAA1111', other, new Date('2026-09-02T10:00:00Z'));
    setExpenseCategory(db, first, food, new Date('2026-09-03T10:00:00Z'));

    expect(findMerchantCategory(db, LEDGER, 'rs:AAAA1111')).toBe(food);

    softDeleteExpense(db, first, NOW);
    expect(findMerchantCategory(db, LEDGER, 'rs:AAAA1111')).toBe(other);
  });
});
