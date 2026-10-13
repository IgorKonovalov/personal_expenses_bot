import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveCategory,
  insertCategory,
  listActiveCategories,
  type CategoryId,
} from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { setExpenseCategory, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { markReceiptFetched } from '../db/receipts.js';
import type { User } from '../db/users.js';
import { woltOrderLines } from '../domain/orders/testing/buildWoltRs.js';
import { parseWoltRs } from '../domain/orders/woltRs.js';
import { createLogger } from '../logger.js';
import { importOrder } from './importOrder.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import {
  activeProductList,
  ledgerProduct,
  ledgerProductList,
  resolveItems,
  sharedNameMatcher,
  unmatchedNames,
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

// The ledger's category with this preset key.
function preset(ledger: LedgerId, key: string): CategoryId {
  const category = listActiveCategories(db, ledger).find((c) => c.presetKey === key);
  if (category === undefined) throw new Error(`no ${key} category`);
  return category.id;
}

// A September milk receipt filed under `category`.
function milkIn(who: User, category: CategoryId, totalMinor: number): ExpenseId {
  const id = receipt(who, '2026-09-15', [['MLEKO 1L', '1', totalMinor]]);
  setExpenseCategory(db, id, category, NOW);
  return id;
}

const september = (product: ProductView) => {
  const line = product.months.find((m) => m.month === '2026-09');
  return line === undefined ? undefined : [line.spentMinor, line.unitPriceMinor];
};

const milk = (ledger: LedgerId = ledgerId) =>
  view(ledgerProduct(deps, { user, ledgerId: ledger, ref: 'b:milk' }));

describe('cafe receipts (ADR-0051)', () => {
  it('leave Молоко at 15000 spent and 15000 per l, and count again once moved to Продукты', () => {
    milkIn(user, preset(ledgerId, 'groceries'), 15000);
    const cafe = milkIn(user, preset(ledgerId, 'cafe'), 40000);

    expect(september(milk())).toEqual([15000, 15000]);

    setExpenseCategory(db, cafe, preset(ledgerId, 'groceries'), NOW);

    expect(september(milk())).toEqual([55000, 27500]);
  });

  it('stay out once Кафе и рестораны is archived', () => {
    const cafe = preset(ledgerId, 'cafe');
    milkIn(user, preset(ledgerId, 'groceries'), 15000);
    milkIn(user, cafe, 40000);
    archiveCategory(db, cafe, NOW);

    expect(september(milk())).toEqual([15000, 15000]);
  });

  it('do not include a user-created Обеды: it counts', () => {
    const lunches = insertCategory(
      db,
      ledgerId,
      { name: 'Обеды', nameKey: 'обеды', presetKey: null },
      NOW,
    );
    milkIn(user, preset(ledgerId, 'groceries'), 15000);
    milkIn(user, lunches, 40000);

    expect(september(milk())).toEqual([55000, 27500]);
  });

  it('stay out of an unlocked sealed ledger: 15000 and 15000', async () => {
    milkIn(user, preset(ledgerId, 'groceries'), 15000);
    milkIn(user, preset(ledgerId, 'cafe'), 40000);
    await sealPersonalLedger(deps, user, NOW);
    await unlockPersonalLedger(deps, user, NOW);

    expect(september(milk())).toEqual([15000, 15000]);
  });

  it("stay out of a group ledger by its own cafe category, and another member's items too", () => {
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
    milkIn(user, preset(shared, 'groceries'), 15000);
    milkIn(user, preset(shared, 'cafe'), 40000);
    milkIn(other, preset(shared, 'groceries'), 50000);

    expect(september(milk(shared))).toEqual([15000, 15000]);
  });
});

describe('delivery orders (ADR-0052)', () => {
  // A Wolt order delivered on 5 October with «Hleb» and an unmatched dish, filed under Продукты.
  function breadOrder(): ExpenseId {
    const parsed = parseWoltRs(
      woltOrderLines({
        delivered: '05.10.2026 12:00',
        payments: [{ label: 'Visa: ****0000', amount: '1.144,00' }],
        items: [
          { name: 'Hleb', total: '169,00', compact: true },
          { name: 'Nudle sa povrćem', total: '975,00' },
        ],
      }),
    );
    if (parsed.kind !== 'order') throw new Error(`setup: order parsed as ${parsed.kind}`);
    const result = importOrder(deps, { user, order: parsed.order, sentAt: NOW, now: NOW });
    if (result.kind !== 'recorded') throw new Error(`setup: order was ${result.kind}`);
    setExpenseCategory(db, result.expense.id, preset(ledgerId, 'groceries'), NOW);
    return result.expense.id;
  }
  const breadOctober = () => {
    const bread = view(ledgerProduct(deps, { user, ledgerId, ref: 'b:bread' }));
    return bread.months.find((m) => m.month === '2026-10')?.spentMinor;
  };
  const ledger = () => list(ledgerProductList(deps, { user, ledgerId, now: NOW })).ledger;

  it('add nothing to Хлеб’s October under Продукты, and stay out of the review', () => {
    fixture();
    breadOrder();

    expect(breadOctober()).toBe(6500);
    const resolved = resolveItems(deps, user, ledger());
    if (isLocked(resolved)) throw new Error('locked');
    // The fixture's 8 items alone, and its one unmatched name.
    expect(resolved.items).toHaveLength(8);
    expect(unmatchedNames(resolved)).toEqual(['cokoladno mleko 0,2l', 'kesa']);
  });

  it('stay out of an unlocked sealed ledger: Хлеб stays at 6500', async () => {
    fixture();
    breadOrder();
    await sealPersonalLedger(deps, user, NOW);
    await unlockPersonalLedger(deps, user, NOW);

    expect(breadOctober()).toBe(6500);
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

  it('folds the 3 receipts from the rows already read: no by-id expense read', async () => {
    fixture();
    await sealPersonalLedger(deps, user, NOW);
    await unlockPersonalLedger(deps, user, NOW);
    const prepare = vi.spyOn(db, 'prepare');

    const products = list(activeProductList(deps, user, NOW));

    const byId = prepare.mock.calls.filter(([sql]) => /WHERE e\.id = \?\s*$/.test(sql));
    expect(byId).toHaveLength(0);
    expect(ranking(products)).toEqual([
      ['Молоко', 73500],
      ['Бананы', 24900],
      ['Хлеб', 6500],
    ]);
  });

  it("keeps a sealed ledger's names out of the shared name matcher", async () => {
    receipt(user, '2026-10-01', [['MLEKO ZAPECACENO 1L', '1', 15000]]);
    receipt(user, '2026-10-02', [['HLEB ZAPECACENI 500G', '1', 7000]]);
    await sealPersonalLedger(deps, user, NOW);
    await unlockPersonalLedger(deps, user, NOW);
    const before = sharedNameMatcher.size;

    const products = list(activeProductList(deps, user, NOW));

    expect(ranking(products)).toEqual([
      ['Молоко', 15000],
      ['Хлеб', 7000],
    ]);
    expect(sharedNameMatcher.size).toBe(before);
  });
});
