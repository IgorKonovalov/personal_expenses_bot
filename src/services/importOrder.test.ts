import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveCategories } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import type { ExpenseId } from '../db/expenses.js';
import { runMigrations } from '../db/migrate.js';
import { updateUserTimezone, type User } from '../db/users.js';
import { woltOrderLines, type WoltOrderFixture } from '../domain/orders/testing/buildWoltRs.js';
import type { DeliveryOrder } from '../domain/orders/types.js';
import { parseWoltRs } from '../domain/orders/woltRs.js';
import { createLogger } from '../logger.js';
import { changeCategory } from './changeCategory.js';
import { exportActiveLedger } from './exportLedger.js';
import { receiptItems } from './fetchDueReceipt.js';
import { importOrder } from './importOrder.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
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

    const second = recorded(importAs(alice, order({ orderId: 'fedcba9876543210fedcba98' })));
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
