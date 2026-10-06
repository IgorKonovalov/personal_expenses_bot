import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { markReceiptFetched } from '../db/receipts.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import { activeProductList, ledgerProduct, type LedgerItems } from './productPrices.js';
import {
  answerName,
  nameInfo,
  pickerProducts,
  productNames,
  reviewableItems,
  reviewQueue,
} from './productReview.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import { recordReceipt } from './recordReceipt.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

// Tuesday 6 October 2026, 12:00 in Belgrade.
const NOW = new Date('2026-10-06T10:00:00Z');

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

type Item = readonly [name: string, quantity: string, totalMinor: number];

// A receipt issued at noon of the local `day`, fetched with `items`.
function receipt(day: string, items: readonly Item[]): void {
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
  db.transaction(() => {
    markReceiptFetched(db, result.receipt.id, 'Test Market');
    insertReceiptItems(
      db,
      result.receipt.id,
      items.map(([name, quantity, totalMinor]) => ({ name, quantity, totalMinor })),
    );
  })();
}

// The plan's fixture, items 1 to 8.
function fixture(): void {
  receipt('2026-09-12', [['MLEKO 2,8%MM 1L IMLEK', '2', 27800]]);
  receipt('2026-10-02', [['MLEKO 0,5L MOJA KRAVICA', '2', 15800]]);
  receipt('2026-10-05', [
    ['МЛЕКО 1Л', '1', 14900],
    ['HLEB BELI 500G', '1', 6500],
    ['BANANA /KG', '1.245', 24900],
    ['ČOKOLADNO MLEKO 0,2L', '1', 9900],
    ['MLEKO IMLEK', '1', 15000],
    ['KESA', '1', 300],
  ]);
}

function items(): LedgerItems {
  const resolved = reviewableItems(deps, { user, ledgerId });
  if (resolved === undefined || resolved === 'sealed' || isLocked(resolved)) {
    throw new Error('reviewable items expected');
  }
  return resolved;
}

function unmatched(): number {
  const list = activeProductList(deps, user, NOW);
  if (isLocked(list)) throw new Error('a list expected');
  return list.unmatched;
}

function october() {
  const milk = ledgerProduct(deps, { user, ledgerId, ref: 'b:milk' });
  if (milk === undefined || isLocked(milk)) throw new Error('milk expected');
  return milk.months.find((m) => m.month === '2026-10');
}

const answer = (nameKey: string, product: string | null) =>
  answerName(deps, { user, ledgerId, nameKey, answer: product, now: NOW });

describe('the review queue', () => {
  it('holds cokoladno mleko 0,2l and kesa: Не разобрано 2', () => {
    fixture();

    expect(reviewQueue(items())).toEqual(['cokoladno mleko 0,2l', 'kesa']);
    expect(unmatched()).toBe(2);
    expect(nameInfo(items(), 'kesa')).toEqual({
      nameKey: 'kesa',
      purchases: 1,
      latest: { amountMinor: 300, currency: 'RSD' },
    });
  });

  it('drops kesa from the queue and from every product once it is not a product', () => {
    fixture();

    expect(answer('kesa', null)).toEqual({ kind: 'answered' });

    expect(reviewQueue(items())).toEqual(['cokoladno mleko 0,2l']);
    expect(unmatched()).toBe(1);
    expect(items().items.find((i) => i.nameKey === 'kesa')?.ref).toBeUndefined();
  });

  it('adds 9900 and 200 ml to October for cokoladno mleko as Молоко: 18455 per l', () => {
    fixture();

    answer('cokoladno mleko 0,2l', 'b:milk');

    expect(october()).toEqual({
      month: '2026-10',
      currency: 'RSD',
      spentMinor: 55600,
      sizedMinor: 40600,
      amount: 2_200_000n,
      unsized: 1,
      unitPriceMinor: 18455,
    });
    expect(reviewQueue(items())).toEqual(['kesa']);
  });

  it('drops 15000 from October when mleko imlek, a rule match, is made not a product', () => {
    fixture();
    expect(productNames(items(), 'b:milk').map((n) => n.nameKey)).toContain('mleko imlek');

    answer('mleko imlek', null);

    expect(october()?.spentMinor).toBe(30700);
    expect(productNames(items(), 'b:milk').map((n) => n.nameKey)).not.toContain('mleko imlek');
    // Answered, so it doesn't come back to the queue.
    expect(reviewQueue(items())).not.toContain('mleko imlek');
  });

  it('writes one row for a double-tapped answer', () => {
    fixture();

    answer('cokoladno mleko 0,2l', 'b:milk');
    answer('cokoladno mleko 0,2l', 'b:milk');

    expect(db.prepare('SELECT user_id, name_key, product FROM item_products').all()).toEqual([
      { user_id: user.id, name_key: 'cokoladno mleko 0,2l', product: 'b:milk' },
    ]);
  });

  it('refuses a product that does not exist', () => {
    fixture();

    expect(answer('kesa', 'b:nope')).toEqual({ kind: 'unknownProduct' });
    expect(db.prepare('SELECT COUNT(*) FROM item_products').pluck().get()).toBe(0);
  });
});

describe('the picker', () => {
  it('puts the products the user buys first, then the catalog in order', () => {
    fixture();

    const refs = pickerProducts(items()).map((p) => p.ref);

    expect(refs.slice(0, 3)).toEqual(['b:milk', 'b:bread', 'b:bananas']);
    expect(refs[3]).toBe('b:yogurt');
  });
});

describe('a sealed ledger', () => {
  it('offers no review and takes no answer', async () => {
    fixture();
    await sealPersonalLedger(deps, user, NOW);
    await unlockPersonalLedger(deps, user, NOW);

    expect(reviewableItems(deps, { user, ledgerId })).toBe('sealed');
    expect(unmatched()).toBe(0);
    expect(answer('kesa', null)).toEqual({ kind: 'sealed' });
    expect(db.prepare('SELECT COUNT(*) FROM item_products').pluck().get()).toBe(0);
  });
});
