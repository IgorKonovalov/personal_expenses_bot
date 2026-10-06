import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { markReceiptFetched } from '../db/receipts.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import {
  activeProductList,
  ledgerProduct,
  ledgerProductList,
  type ProductList,
  type ProductView,
} from './productPrices.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import { recordReceipt } from './recordReceipt.js';
import { seedLedgerCategories } from './seedCategories.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

// Tuesday 6 October 2026, 12:00 in Belgrade.
const NOW = new Date('2026-10-06T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let other: User;
let ledgerId: LedgerId;
let fiscal = 0;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => NOW),
  };
  const provision = (externalId: string) =>
    provisionUser(deps, {
      provider: 'telegram',
      externalId,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    });
  const provisioned = provision('1001');
  user = provisioned.user;
  ledgerId = provisioned.ledger.id;
  other = provision('1002').user;
});

type Item = readonly [name: string, quantity: string, totalMinor: number];

// A receipt issued at noon of the local `day`, recorded into `who`'s active ledger and fetched
// with `items`. Returns the expense id.
function receipt(who: User, day: string, items: readonly Item[]): ExpenseId {
  const instant = new Date(`${day}T10:00:00Z`);
  const result = recordReceipt(deps, {
    user: who,
    receipt: {
      country: 'RS',
      fiscalId: `FISCAL-${++fiscal}`,
      merchantKey: 'rs:test',
      totalMinor: items.reduce((sum, [, , minor]) => sum + minor, 0),
      currency: 'RSD',
      issuedAt: instant,
      verifyUrl: `https://example.test/v/${fiscal}`,
    },
    placeholder: 'Чек',
    occurredAt: instant,
    now: NOW,
  });
  if (result.kind !== 'recorded') throw new Error(`receipt not recorded: ${result.kind}`);
  db.transaction(() => {
    markReceiptFetched(db, result.receipt.id, 'Test Market');
    insertReceiptItems(
      db,
      result.receipt.id,
      items.map(([name, quantity, totalMinor]) => ({ name, quantity, totalMinor })),
    );
  })();
  return result.expense.id;
}

// The plan's fixture, items 1 to 8, in `who`'s active ledger.
function fixture(who: User = user): void {
  receipt(who, '2026-09-12', [['MLEKO 2,8%MM 1L IMLEK', '2', 27800]]);
  receipt(who, '2026-10-02', [['MLEKO 0,5L MOJA KRAVICA', '2', 15800]]);
  receipt(who, '2026-10-05', [
    ['МЛЕКО 1Л', '1', 14900],
    ['HLEB BELI 500G', '1', 6500],
    ['BANANA /KG', '1.245', 24900],
    ['ČOKOLADNO MLEKO 0,2L', '1', 9900],
    ['MLEKO IMLEK', '1', 15000],
    ['KESA', '1', 300],
  ]);
}

function list(value: ProductList | Locked | undefined): ProductList {
  if (value === undefined || isLocked(value)) throw new Error('a list expected');
  return value;
}

function view(value: ProductView | Locked | undefined): ProductView {
  if (value === undefined || isLocked(value)) throw new Error('a product expected');
  return value;
}

const spent = (product: ProductView) => product.totals.map((t) => [t.currency, t.spentMinor]);

const ranking = (products: ProductList) =>
  products.products.map((p) => [p.name, p.recentMinor] as const);

describe('activeProductList', () => {
  it('ranks Молоко 73500 above Бананы 24900 above Хлеб 6500', () => {
    fixture();

    expect(ranking(list(activeProductList(deps, user, NOW)))).toEqual([
      ['Молоко', 73500],
      ['Бананы', 24900],
      ['Хлеб', 6500],
    ]);
  });

  it('ranks by the last 12 months only: a purchase from November 2025 lists at 0', () => {
    receipt(user, '2025-10-31', [['MLEKO 1L', '1', 99999]]);
    receipt(user, '2025-11-01', [['HLEB 500G', '1', 5000]]);

    expect(ranking(list(activeProductList(deps, user, NOW)))).toEqual([
      ['Хлеб', 5000],
      ['Молоко', 0],
    ]);
  });
});

describe('ledgerProduct', () => {
  it('shows Молоко: October 45700 at 153.50/l, September 27800 at 139.00/l, all time 146.25/l', () => {
    fixture();

    const milk = view(ledgerProduct(deps, { user, ledgerId, ref: 'b:milk' }));

    expect(milk.name).toBe('Молоко');
    expect(milk.unit).toBe('l');
    // October: items 2 and 3 are 30700 over 2000 ml; item 7 has no size, so spend only.
    expect(milk.months).toEqual([
      {
        month: '2026-10',
        currency: 'RSD',
        spentMinor: 45700,
        sizedMinor: 30700,
        amount: 2_000_000n,
        unsized: 1,
        unitPriceMinor: 15350,
      },
      {
        month: '2026-09',
        currency: 'RSD',
        spentMinor: 27800,
        sizedMinor: 27800,
        amount: 2_000_000n,
        unsized: 0,
        unitPriceMinor: 13900,
      },
    ]);
    expect(milk.totals).toEqual([
      {
        currency: 'RSD',
        spentMinor: 73500,
        sizedMinor: 58500,
        amount: 4_000_000n,
        unsized: 1,
        unitPriceMinor: 14625,
      },
    ]);
  });

  it('weighs the bananas: 1245 g at 200.00 per kg', () => {
    fixture();

    const bananas = view(ledgerProduct(deps, { user, ledgerId, ref: 'b:bananas' }));

    expect(bananas.totals).toEqual([
      {
        currency: 'RSD',
        spentMinor: 24900,
        sizedMinor: 24900,
        amount: 1_245_000n,
        unsized: 0,
        unitPriceMinor: 20000,
      },
    ]);
  });

  it('counts no deleted expense', () => {
    fixture();
    softDeleteExpense(db, receipt(user, '2026-10-06', [['MLEKO 1L', '1', 50000]]), NOW);

    const milk = view(ledgerProduct(deps, { user, ledgerId, ref: 'b:milk' }));

    expect(spent(milk)).toEqual([['RSD', 73500]]);
  });

  it('answers undefined for a product with no items, an unknown ref, or a non-member', () => {
    fixture();

    expect(ledgerProduct(deps, { user, ledgerId, ref: 'b:eggs' })).toBeUndefined();
    expect(ledgerProduct(deps, { user, ledgerId, ref: 'b:nope' })).toBeUndefined();
    expect(ledgerProduct(deps, { user: other, ledgerId, ref: 'b:milk' })).toBeUndefined();
    expect(ledgerProductList(deps, { user: other, ledgerId, now: NOW })).toBeUndefined();
  });
});

describe('a shared ledger', () => {
  it("leaves another member's receipts out of every total", () => {
    const shared = 'ledger-shared' as LedgerId;
    insertLedger(db, {
      id: shared,
      kind: 'shared',
      name: 'Семья',
      defaultCurrency: 'RSD',
      ownerUserId: user.id,
      timezone: 'Europe/Belgrade',
      createdAt: NOW,
    });
    insertMember(db, { ledgerId: shared, userId: user.id, role: 'owner' });
    insertMember(db, { ledgerId: shared, userId: other.id, role: 'member' });
    db.prepare('UPDATE users SET active_ledger_id = ?').run(shared);
    seedLedgerCategories(db, shared, NOW);
    fixture(user);
    receipt(other, '2026-10-05', [['MLEKO 1L', '1', 50000]]);

    const milk = view(ledgerProduct(deps, { user, ledgerId: shared, ref: 'b:milk' }));

    expect(spent(milk)).toEqual([['RSD', 73500]]);
    expect(ranking(list(ledgerProductList(deps, { user, ledgerId: shared, now: NOW })))).toEqual([
      ['Молоко', 73500],
      ['Бананы', 24900],
      ['Хлеб', 6500],
    ]);
  });
});

describe('the arithmetic gate (ADR-0039)', () => {
  // Quantities are read and amounts divided in src/domain/products/amount.ts only: elsewhere in
  // the products code, outside comments, no parseFloat, Number(...), BigInt(...) or division.
  const files = [
    ...readdirSync('src/domain/products')
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'amount.ts')
      .map((f) => join('src/domain/products', f)),
    'src/services/productPrices.ts',
  ];

  it('covers the products modules', () => {
    expect(files).toEqual(expect.arrayContaining(['src/domain/products/monthly.ts']));
  });

  it.each(files)('%s', (file) => {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    expect(code).not.toMatch(/parseFloat|Number\(|BigInt\(/);
    expect(code).not.toMatch(/\s\/\s/);
  });
});

describe('a sealed ledger', () => {
  it('is locked without its key, and reads the folded receipts once unlocked', async () => {
    fixture();
    await sealPersonalLedger(deps, user, NOW);
    deps.keys.lock(ledgerId);

    expect(isLocked(activeProductList(deps, user, NOW))).toBe(true);
    expect(isLocked(ledgerProduct(deps, { user, ledgerId, ref: 'b:milk' }))).toBe(true);

    await unlockPersonalLedger(deps, user, NOW);
    const milk = view(ledgerProduct(deps, { user, ledgerId, ref: 'b:milk' }));
    expect(spent(milk)).toEqual([['RSD', 73500]]);
  });
});
