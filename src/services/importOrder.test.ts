import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveCategories } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import type { ExpenseId } from '../db/expenses.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { insertReceipt, markReceiptFetched, type ReceiptId } from '../db/receipts.js';
import { setActiveLedger, updateUserTimezone, type User } from '../db/users.js';
import { woltOrderLines, type WoltOrderFixture } from '../domain/orders/testing/buildWoltRs.js';
import type { DeliveryOrder } from '../domain/orders/types.js';
import { parseWoltRs } from '../domain/orders/woltRs.js';
import { createLogger } from '../logger.js';
import { changeCategory } from './changeCategory.js';
import { exportActiveLedger } from './exportLedger.js';
import { receiptItems } from './fetchDueReceipt.js';
import { answerOrder, cancelOrder, importOrder } from './importOrder.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { seedLedgerCategories } from './seedCategories.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

const SENT = new Date('2026-10-12T15:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let logLines: string[];
let alice: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, SENT);
  let n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => SENT),
  };
  alice = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: SENT,
  }).user;
});

function order(overrides: Partial<WoltOrderFixture> = {}): DeliveryOrder {
  const parsed = parseWoltRs(woltOrderLines(overrides));
  if (parsed.kind !== 'order') throw new Error(`setup: fixture parsed as ${parsed.kind}`);
  return parsed.order;
}

function importAs(user: User, parsed = order(), sentAt = SENT) {
  return importOrder(deps, { user, order: parsed, sentAt, now: sentAt });
}

function recorded(result: ReturnType<typeof importAs>) {
  if (result.kind !== 'recorded') throw new Error(`expected recorded, got ${result.kind}`);
  return result;
}

function rows(sql: string): unknown[] {
  return db.prepare(sql).all();
}

function categoryName(expenseId: string): unknown {
  return db
    .prepare(
      'SELECT c.name FROM expenses e JOIN categories c ON c.id = e.category_id WHERE e.id = ?',
    )
    .pluck()
    .get(expenseId);
}

describe('importOrder', () => {
  it('records the total in RSD at the delivery instant, with an order receipt and two items', () => {
    const result = recorded(importAs(alice));

    expect(result.duplicate).toBe(false);
    expect(
      rows(`SELECT amount_minor, currency, description, occurred_at, occurred_on, source_key
              FROM expenses`),
    ).toEqual([
      {
        amount_minor: 114400,
        currency: 'RSD',
        description: 'Primer Kuhinja',
        // CEST is UTC+2 until 2026-10-25.
        occurred_at: '2026-10-12T11:26:00.000Z',
        occurred_on: '2026-10-12',
        source_key: `order:wolt-rs:0123456789abcdef01234567:${result.ledger.id}`,
      },
    ]);
    expect(
      rows(`SELECT kind, country, fiscal_id, verify_url, order_key, merchant_key, issued_at,
                   seller_name, fetch_state FROM receipts`),
    ).toEqual([
      {
        kind: 'order',
        country: null,
        fiscal_id: null,
        verify_url: null,
        order_key: `wolt-rs:0123456789abcdef01234567:${result.ledger.id}`,
        merchant_key: 'wolt-rs:123456789',
        issued_at: '2026-10-12T11:26:00.000Z',
        seller_name: 'Primer Kuhinja',
        fetch_state: 'fetched',
      },
    ]);
    expect(rows('SELECT position, name, quantity, total_minor FROM receipt_items')).toEqual([
      { position: 1, name: 'Nudle sa povrćem', quantity: '1', total_minor: 97500 },
      { position: 2, name: 'Prolećne rolnice', quantity: '1', total_minor: 16900 },
    ]);
  });

  it('dates an order delivered at 01:30 in Serbia by the user’s own timezone', () => {
    const late = order({ delivered: '12.10.2026 01:30' });
    const belgrade = recorded(importAs(alice, late));
    expect(belgrade.expense.occurredAt.toISOString()).toBe('2026-10-11T23:30:00.000Z');
    expect(belgrade.expense.occurredOn).toBe('2026-10-12');

    const bob = provisionUser(deps, {
      provider: 'telegram',
      externalId: '1002',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: SENT,
    }).user;
    updateUserTimezone(db, bob.id, 'America/New_York');
    const newYork = recorded(importAs({ ...bob, timezone: 'America/New_York' }, late));
    expect(newYork.expense.occurredAt.toISOString()).toBe('2026-10-11T23:30:00.000Z');
    expect(newYork.expense.occurredOn).toBe('2026-10-11');
  });

  it('a second import of the same order returns the stored expense and writes nothing', () => {
    const first = recorded(importAs(alice));
    const second = recorded(importAs(alice));

    expect(second.duplicate).toBe(true);
    expect(second.expense.id).toBe(first.expense.id);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(rows('SELECT COUNT(*) AS n FROM expenses')).toEqual([{ n: 1 }]);
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 1 }]);
    expect(rows('SELECT COUNT(*) AS n FROM receipt_items')).toEqual([{ n: 2 }]);
  });

  it('files a first order under the cafe preset, then follows the seller’s history', () => {
    const first = recorded(importAs(alice));
    expect(categoryName(first.expense.id)).toBe('Кафе и рестораны');

    const groceries = listActiveCategories(db, first.ledger.id).find(
      (c) => c.presetKey === 'groceries',
    );
    if (groceries === undefined) throw new Error('setup: no groceries category');
    const later = new Date(SENT.getTime() + 60_000);
    expect(
      changeCategory(deps, {
        user: alice,
        expenseId: first.expense.id,
        categoryId: groceries.id,
        now: later,
      }),
    ).toMatchObject({ kind: 'changed' });

    // Another order from the same seller, of another total, so it matches no expense.
    const rolls = order({
      orderId: 'fedcba9876543210fedcba98',
      payments: [{ label: 'Visa: ****0000', amount: '169,00' }],
      items: [{ name: 'Prolećne rolnice', total: '169,00', compact: true }],
      total: '169,00',
    });
    const second = recorded(importAs(alice, rolls));
    expect(second.duplicate).toBe(false);
    expect(categoryName(second.expense.id)).toBe(groceries.name);
  });

  it('refuses a delivery dated after the day the PDF was sent', () => {
    expect(importAs(alice, order({ delivered: '13.10.2026 09:00' }))).toEqual({
      kind: 'futureOrder',
    });
    expect(rows('SELECT COUNT(*) AS n FROM expenses')).toEqual([{ n: 0 }]);
  });

  it('refuses an order into a sealed ledger', async () => {
    await sealPersonalLedger(deps, alice, SENT);
    expect(importAs(alice)).toEqual({ kind: 'sealedLedger' });
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 0 }]);
  });

  it('logs ids and counts, never the restaurant, an amount or a dish', () => {
    recorded(importAs(alice));
    recorded(importAs(alice));
    const log = logLines.join('\n');
    expect(log).toContain('order recorded');
    expect(log).toContain('duplicate order');
    for (const secret of ['Primer Kuhinja', '114400', '1144', 'Nudle', '123456789']) {
      expect(log, secret).not.toContain(secret);
    }
  });
});

describe('an order in a sealed ledger', () => {
  it('folds into the sealed row with a null link and both items, and exports with them', async () => {
    const result = recorded(importAs(alice));
    const expenseId: ExpenseId = result.expense.id;
    await sealPersonalLedger(deps, alice, SENT);
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 0 }]);

    await unlockPersonalLedger(deps, alice, SENT);
    expect(receiptItems(deps, { user: alice, expenseId })).toMatchObject({
      kind: 'items',
      sellerName: 'Primer Kuhinja',
      items: [
        { name: 'Nudle sa povrćem', quantity: '1', totalMinor: 97500 },
        { name: 'Prolećne rolnice', quantity: '1', totalMinor: 16900 },
      ],
    });

    const exported = exportActiveLedger(deps, { user: alice, range: 'all', now: SENT });
    if (isLocked(exported)) throw new Error('export was locked');
    expect(exported.expenses).toMatchObject([
      { id: expenseId, shop: 'Primer Kuhinja', receiptUrl: null },
    ]);
    expect(exported.items.map((item) => [item.name, item.total.amountMinor])).toEqual([
      ['Nudle sa povrćem', 97500],
      ['Prolećne rolnice', 16900],
    ]);
  });

  it('exports a plaintext ledger’s order with a null link and its items', () => {
    const result = recorded(importAs(alice));
    const exported = exportActiveLedger(deps, { user: alice, range: 'all', now: SENT });
    if (isLocked(exported)) throw new Error('export was locked');
    expect(exported.expenses).toMatchObject([
      { id: result.expense.id, shop: 'Primer Kuhinja', receiptUrl: null },
    ]);
    expect(exported.items).toHaveLength(2);
  });
});

describe('an order matching a recorded expense (Phase 2)', () => {
  let inputs = 0;
  // A hand-typed expense, sent at noon UTC on `date`.
  function typed(user: User, text: string, date: string) {
    const at = new Date(`${date}T12:00:00Z`);
    const result = recordExpense(deps, {
      user,
      text,
      sourceKey: `tg:${user.id}:${String(++inputs)}`,
      occurredAt: at,
      now: at,
    });
    if (result.kind !== 'recorded') throw new Error(`setup: ${text} was ${result.kind}`);
    return result.expense;
  }
  const count = (table: string) =>
    db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  const answer = (choice: 'same' | 'new') =>
    answerOrder(deps, { user: alice, answer: choice, now: SENT });

  it('asks about a 1144 RSD expense typed the day before, and [Да] attaches the dishes', () => {
    const before = typed(alice, '1144 доставка', '2026-10-11');
    const categoryBefore = categoryName(before.id);

    const asked = importAs(alice);
    expect(asked).toMatchObject({ kind: 'asked', candidate: { id: before.id } });
    expect(count('receipts')).toBe(0);

    expect(answer('same')).toMatchObject({ kind: 'attached', expense: { id: before.id } });
    expect(count('expenses')).toBe(1);
    expect(
      rows(`SELECT r.kind, r.expense_id, COUNT(i.position) AS items
              FROM receipts r JOIN receipt_items i ON i.receipt_id = r.id GROUP BY r.id`),
    ).toEqual([{ kind: 'order', expense_id: before.id, items: 2 }]);
    expect(rows('SELECT amount_minor, description, occurred_on FROM expenses')).toEqual([
      { amount_minor: 114400, description: 'доставка', occurred_on: '2026-10-11' },
    ]);
    expect(categoryName(before.id)).toBe(categoryBefore);
  });

  it('asks nothing for an expense two days before', () => {
    typed(alice, '1144 доставка', '2026-10-10');
    expect(importAs(alice)).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(count('expenses')).toBe(2);
  });

  it('asks nothing for an expense of 1143 RSD the same day', () => {
    typed(alice, '1143 доставка', '2026-10-12');
    expect(importAs(alice)).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(count('expenses')).toBe(2);
  });

  it('[Да] on a candidate with a fiscal receipt writes nothing, and its three items stay', () => {
    const candidate = typed(alice, '1144 доставка', '2026-10-12');
    const receiptId = 'fiscal-receipt' as ReceiptId;
    insertReceipt(db, {
      id: receiptId,
      expenseId: candidate.id,
      country: 'RS',
      fiscalId: 'fiscal-1',
      merchantKey: 'rs:shop',
      verifyUrl: 'https://example.test/v',
      issuedAt: SENT,
      createdAt: SENT,
    });
    markReceiptFetched(db, receiptId, 'Shop');
    insertReceiptItems(db, receiptId, [
      { name: 'a', quantity: '1', totalMinor: 100000 },
      { name: 'b', quantity: '1', totalMinor: 10000 },
      { name: 'c', quantity: '1', totalMinor: 4400 },
    ]);

    expect(importAs(alice)).toMatchObject({ kind: 'asked' });
    expect(answer('same')).toMatchObject({ kind: 'hasItems', expense: { id: candidate.id } });

    expect(rows('SELECT kind FROM receipts')).toEqual([{ kind: 'fiscal' }]);
    expect(count('receipt_items')).toBe(3);
    expect(count('expenses')).toBe(1);
  });

  it('[Нет] records the order apart, and [Отмена] records nothing', () => {
    typed(alice, '1144 доставка', '2026-10-12');
    importAs(alice);
    expect(answer('new')).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(count('expenses')).toBe(2);

    importAs(alice, order({ orderId: 'fedcba9876543210fedcba98' }));
    expect(cancelOrder(deps, { user: alice, now: SENT })).toBe(true);
    expect(count('expenses')).toBe(2);
    expect(answer('same')).toEqual({ kind: 'expired' });
  });

  it('a second [Да] finds nothing pending and writes one receipt row', () => {
    typed(alice, '1144 доставка', '2026-10-12');
    importAs(alice);
    expect(answer('same')).toMatchObject({ kind: 'attached' });
    expect(answer('same')).toEqual({ kind: 'expired' });
    expect(count('receipts')).toBe(1);
  });

  it('a [Да] after the flow expired answers expired', () => {
    typed(alice, '1144 доставка', '2026-10-12');
    importAs(alice);
    const late = new Date(SENT.getTime() + 10 * 60 * 1000);
    expect(answerOrder(deps, { user: alice, answer: 'same', now: late })).toEqual({
      kind: 'expired',
    });
    expect(count('receipts')).toBe(0);
  });

  it('records the order as new when the candidate was deleted meanwhile', () => {
    const candidate = typed(alice, '1144 доставка', '2026-10-12');
    importAs(alice);
    db.prepare('UPDATE expenses SET deleted_at = ? WHERE id = ?').run(
      SENT.toISOString(),
      candidate.id,
    );

    expect(answer('same')).toMatchObject({ kind: 'recorded', candidateGone: true });
    expect(rows('SELECT COUNT(*) AS n FROM expenses WHERE deleted_at IS NULL')).toEqual([{ n: 1 }]);
    expect(count('receipts')).toBe(1);
  });

  it('another member’s 1144 RSD expense in a shared ledger is no candidate', () => {
    const shared = 'ledger-shared' as LedgerId;
    const bob = provisionUser(deps, {
      provider: 'telegram',
      externalId: '1002',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: SENT,
    }).user;
    insertLedger(db, {
      id: shared,
      kind: 'shared',
      name: 'Family',
      defaultCurrency: 'RSD',
      timezone: 'Europe/Belgrade',
      ownerUserId: alice.id,
      createdAt: SENT,
    });
    insertMember(db, { ledgerId: shared, userId: alice.id, role: 'owner' });
    insertMember(db, { ledgerId: shared, userId: bob.id, role: 'member' });
    seedLedgerCategories(db, shared, SENT);
    setActiveLedger(db, alice.id, shared);
    setActiveLedger(db, bob.id, shared);
    typed({ ...bob, activeLedgerId: shared }, '1144 доставка', '2026-10-12');

    expect(importAs({ ...alice, activeLedgerId: shared })).toMatchObject({
      kind: 'recorded',
      duplicate: false,
    });
    expect(count('expenses')).toBe(2);
  });

  it('after [Да], the same PDF again answers «уже записано» without asking', () => {
    const candidate = typed(alice, '1144 доставка', '2026-10-11');
    importAs(alice);
    answer('same');

    expect(importAs(alice)).toMatchObject({
      kind: 'recorded',
      duplicate: true,
      expense: { id: candidate.id },
    });
    expect(count('expenses')).toBe(1);
  });
});
