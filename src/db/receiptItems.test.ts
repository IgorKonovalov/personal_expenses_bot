import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase, type Db } from './connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { countReceiptItems, insertReceiptItems, listReceiptItems } from './receiptItems.js';
import { insertReceipt, type ReceiptId } from './receipts.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const RECEIPT = 'receipt-1' as ReceiptId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: 'user-a' as UserId, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertLedger(db, {
    id: 'ledger-a' as LedgerId,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: 'user-a' as UserId,
    createdAt: NOW,
  });
  insertMember(db, { ledgerId: 'ledger-a' as LedgerId, userId: 'user-a' as UserId, role: 'owner' });
  insertExpenseOrGetExisting(db, {
    id: 'expense-1' as ExpenseId,
    ledgerId: 'ledger-a' as LedgerId,
    createdBy: 'user-a' as UserId,
    amountMinor: 4250,
    currency: 'EUR',
    description: 'Чек',
    occurredAt: NOW,
    occurredOn: '2026-10-01' as LocalDate,
    sourceKey: 'rcpt:ME:x:ledger-a',
    createdAt: NOW,
  });
  insertReceipt(db, {
    id: RECEIPT,
    expenseId: 'expense-1' as ExpenseId,
    country: 'ME',
    fiscalId: 'x',
    merchantKey: 'me:02000000:ab123cd456',
    verifyUrl: 'https://mapr.tax.gov.me/ic/#/verify?iic=x',
    issuedAt: NOW,
    createdAt: NOW,
  });
});

describe('receipt items', () => {
  it('lists items in the order they were inserted, with quantity kept as text', () => {
    insertReceiptItems(db, RECEIPT, [
      { name: 'Hljeb', quantity: '2', totalMinor: 240 },
      { name: 'Sir', quantity: '0.535', totalMinor: 4010 },
    ]);

    expect(listReceiptItems(db, RECEIPT)).toEqual([
      { name: 'Hljeb', quantity: '2', totalMinor: 240 },
      { name: 'Sir', quantity: '0.535', totalMinor: 4010 },
    ]);
    expect(countReceiptItems(db, RECEIPT)).toBe(2);
  });

  it('rejects a second insert of the same positions', () => {
    const items = [{ name: 'Hljeb', quantity: '2', totalMinor: 240 }];
    insertReceiptItems(db, RECEIPT, items);

    expect(() => {
      insertReceiptItems(db, RECEIPT, items);
    }).toThrow(/UNIQUE|PRIMARY KEY/);
  });
});
