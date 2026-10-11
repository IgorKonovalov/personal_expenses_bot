import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveCategories, type CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { setExpenseCategory, type ExpenseId } from '../db/expenses.js';
import { setItemProduct } from '../db/itemProducts.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { markReceiptFetched } from '../db/receipts.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from '../services/ledgerKeys.js';
import { provisionUser } from '../services/provisionUser.js';
import type { RecordDeps } from '../services/recordExpense.js';
import { recordReceipt } from '../services/recordReceipt.js';
import { coverage, formatCoverage } from './productsCoverage.js';

// Tuesday 6 October 2026, 12:00 in Belgrade.
const NOW = new Date('2026-10-06T10:00:00Z');

// The plan's fixture: local day, name, quantity, total, and whether a rule matches it.
const FIXTURE = [
  ['2026-09-12', 'MLEKO 2,8%MM 1L IMLEK', '2', 27800, true],
  ['2026-10-02', 'MLEKO 0,5L MOJA KRAVICA', '2', 15800, true],
  ['2026-10-05', 'МЛЕКО 1Л', '1', 14900, true],
  ['2026-10-05', 'HLEB BELI 500G', '1', 6500, true],
  ['2026-10-05', 'BANANA /KG', '1.245', 24900, true],
  ['2026-10-05', 'ČOKOLADNO MLEKO 0,2L', '1', 9900, false],
  ['2026-10-05', 'MLEKO IMLEK', '1', 15000, true],
  ['2026-10-05', 'KESA', '1', 300, false],
] as const;

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
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
  const provisioned = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  });
  user = provisioned.user;
  ledgerId = provisioned.ledger.id;
});

// A receipt issued at noon of the local `day`, fetched with `items`. Returns the expense id.
function receipt(
  day: string,
  items: readonly (readonly [name: string, quantity: string, totalMinor: number])[],
): ExpenseId {
  const instant = new Date(`${day}T10:00:00Z`);
  const result = recordReceipt(deps, {
    user,
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
  markReceiptFetched(db, result.receipt.id, 'Test Market');
  insertReceiptItems(
    db,
    result.receipt.id,
    items.map(([name, quantity, totalMinor]) => ({ name, quantity, totalMinor })),
  );
  return result.expense.id;
}

const sum = (rows: readonly (typeof FIXTURE)[number][]) =>
  rows.reduce((total, [, , , minor]) => total + minor, 0);

describe('products coverage', () => {
  // One receipt per local day, holding that day's fixture rows.
  beforeEach(() => {
    for (const day of new Set(FIXTURE.map(([d]) => d))) {
      receipt(
        day,
        FIXTURE.filter(([d]) => d === day).map(([, name, quantity, minor]) => [
          name,
          quantity,
          minor,
        ]),
      );
    }
  });

  it('counts 6 of 8 items and 104900 of 115100 matched by rules, none by overrides', () => {
    const matched = FIXTURE.filter(([, , , , rule]) => rule);
    const unmatched = FIXTURE.filter(([, , , , rule]) => !rule);

    const report = coverage(db);

    expect(report.ledgers).toEqual([
      expect.objectContaining({
        kind: 'personal',
        currency: 'RSD',
        rules: { items: matched.length, spentMinor: sum(matched) },
        overrides: { items: 0, spentMinor: 0 },
        unmatched: { items: unmatched.length, spentMinor: sum(unmatched) },
      }),
    ]);
    expect([matched.length, sum(matched), sum(FIXTURE)]).toEqual([6, 104900, 115100]);
    expect(sum(unmatched)).toBe(9900 + 300);
    expect(report.topUnmatched).toEqual([
      { nameKey: 'cokoladno mleko 0,2l', items: 1 },
      { nameKey: 'kesa', items: 1 },
    ]);
  });

  it('counts an answered product as an override and "not a product" as unmatched', () => {
    setItemProduct(db, user.id, 'cokoladno mleko 0,2l', 'b:milk', NOW);
    setItemProduct(db, user.id, 'mleko imlek', null, NOW);

    const [ledger] = coverage(db).ledgers;

    expect(ledger?.rules).toEqual({ items: 5, spentMinor: 104900 - 15000 });
    expect(ledger?.overrides).toEqual({ items: 1, spentMinor: 9900 });
    expect(ledger?.unmatched).toEqual({ items: 2, spentMinor: 15000 + 300 });
  });

  it('prints the shares per ledger and the unmatched names', () => {
    const text = formatCoverage(coverage(db));

    expect(text).toContain('  items: 8: rules 6 (75.0%), overrides 0 (0.0%), unmatched 2 (25.0%)');
    expect(text).toContain(
      '  spend: 1 151.00 RSD: rules 1 049.00 RSD (91.1%), overrides 0.00 RSD (0.0%), unmatched 102.00 RSD (8.9%)',
    );
    expect(text.endsWith('unmatched names, top 30:\n  1\tcokoladno mleko 0,2l\n  1\tkesa')).toBe(
      true,
    );
  });

  it('writes nothing', () => {
    const changes = () => db.prepare('SELECT total_changes()').pluck().get();
    const before = changes();

    coverage(db);

    expect(changes()).toBe(before);
  });
});

describe('cafe receipts (ADR-0051)', () => {
  // The ledger's category with this preset key.
  const preset = (key: string): CategoryId => {
    const category = listActiveCategories(db, ledgerId).find((c) => c.presetKey === key);
    if (category === undefined) throw new Error(`no ${key} category`);
    return category.id;
  };

  it('leaves a cafe item out of the shares and the unmatched names, and counts it apart', () => {
    const shop = receipt('2026-10-05', [['MLEKO 1L', '1', 15000]]);
    setExpenseCategory(db, shop, preset('groceries'), NOW);
    const cafe = receipt('2026-10-05', [['CAPPUCCINO', '1', 40000]]);
    setExpenseCategory(db, cafe, preset('cafe'), NOW);

    const report = coverage(db);
    const text = formatCoverage(report);

    expect(report.ledgers).toEqual([
      expect.objectContaining({
        rules: { items: 1, spentMinor: 15000 },
        overrides: { items: 0, spentMinor: 0 },
        unmatched: { items: 0, spentMinor: 0 },
        cafe: { items: 1, spentMinor: 40000 },
      }),
    ]);
    expect(report.topUnmatched).toEqual([]);
    expect(text).toContain('  items: 1: rules 1 (100.0%), overrides 0 (0.0%), unmatched 0 (0.0%)');
    expect(text).toContain('  cafe: 1 item, 400.00 RSD');
    expect(text).not.toContain('cappuccino');
  });
});
