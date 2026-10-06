import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { markReceiptFetched } from '../db/receipts.js';
import type { User } from '../db/users.js';
import { monthOf, weekOf } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import { activePeriodItems, ledgerPeriodItems, type PeriodItems } from './periodItems.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { recordReceipt } from './recordReceipt.js';
import { seedLedgerCategories } from './seedCategories.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

// Tuesday 6 October 2026, 12:00 in Belgrade (CEST). The week runs Monday 5 to Sunday 11.
const NOW = new Date('2026-10-06T10:00:00Z');
const WEEK = weekOf('2026-10-06' as LocalDate);
const MONTH = monthOf('2026-10-06' as LocalDate);

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

function categoryOf(ledger: LedgerId, preset: string): CategoryId {
  return db
    .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
    .pluck()
    .get(ledger, preset) as CategoryId;
}

// Names the groceries preset «Еда» and the household one «Дом» in a ledger.
function nameCategories(ledger: LedgerId): { food: CategoryId; home: CategoryId } {
  const food = categoryOf(ledger, 'groceries');
  const home = categoryOf(ledger, 'housing');
  db.prepare("UPDATE categories SET name = 'Еда' WHERE id = ?").run(food);
  db.prepare("UPDATE categories SET name = 'Дом' WHERE id = ?").run(home);
  return { food, home };
}

// A receipt issued at `issuedAt`, recorded into `who`'s active ledger, fetched with `items` and
// put in `category`. Returns the expense id.
function receipt(
  who: User,
  issuedAt: string,
  category: CategoryId,
  items: readonly (readonly [string, number])[],
): ExpenseId {
  const instant = new Date(issuedAt);
  const total = items.reduce((sum, [, minor]) => sum + minor, 0);
  const result = recordReceipt(deps, {
    user: who,
    receipt: {
      country: 'RS',
      fiscalId: `FISCAL-${++fiscal}`,
      merchantKey: 'rs:test',
      totalMinor: total,
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
      items.map(([name, totalMinor]) => ({ name, quantity: '1', totalMinor })),
    );
  })();
  db.prepare('UPDATE expenses SET category_id = ? WHERE id = ?').run(category, result.expense.id);
  return result.expense.id;
}

// The plan's fixture, A to F, in the user's personal ledger.
function fixture(): void {
  const { food, home } = nameCategories(ledgerId);
  receipt(user, '2026-10-05T09:00:00Z', food, [
    ['Хлеб', 7999],
    ['Молоко', 14900],
  ]);
  receipt(user, '2026-10-06T08:00:00Z', food, [['Хлеб', 8499]]);
  receipt(user, '2026-10-06T09:00:00Z', home, [['Средство', 39900]]);
  receipt(user, '2026-10-04T09:00:00Z', food, [['Хлеб', 7599]]);
  const e = receipt(user, '2026-10-06T09:30:00Z', food, [['Сыр', 50000]]);
  softDeleteExpense(db, e, NOW);
  receipt(user, '2026-10-06T22:30:00Z', food, [['Кофе', 30000]]);
}

function open(value: PeriodItems | Locked | undefined): PeriodItems {
  if (value === undefined || isLocked(value)) throw new Error('items expected');
  return value;
}

const shape = (items: PeriodItems) =>
  items.groups.map((g) => ({
    name: g.categoryName,
    totals: g.totals.map((t) => t.amountMinor),
    items: g.items.map((i) => `${i.name} ${i.occurredOn.slice(8)}.${i.occurredOn.slice(5, 7)}`),
  }));

describe('ledgerPeriodItems', () => {
  it('groups the week: Еда 61398 with Кофе, Молоко, Хлеб, Хлеб, then Дом 39900', () => {
    fixture();

    const week = open(ledgerPeriodItems(deps, { user, ledgerId, range: WEEK, now: NOW }));

    expect(shape(week)).toEqual([
      {
        name: 'Еда',
        totals: [61398],
        items: ['Кофе 07.10', 'Молоко 05.10', 'Хлеб 05.10', 'Хлеб 06.10'],
      },
      { name: 'Дом', totals: [39900], items: ['Средство 06.10'] },
    ]);
    expect(week.withoutReceipt).toBe(0);
  });

  it('groups October: Еда 68997 with five items and Дом 39900, never the deleted Сыр', () => {
    fixture();

    const month = open(ledgerPeriodItems(deps, { user, ledgerId, range: MONTH, now: NOW }));

    expect(shape(month)).toEqual([
      {
        name: 'Еда',
        totals: [68997],
        items: ['Кофе 07.10', 'Молоко 05.10', 'Хлеб 04.10', 'Хлеб 05.10', 'Хлеб 06.10'],
      },
      { name: 'Дом', totals: [39900], items: ['Средство 06.10'] },
    ]);
  });

  it('counts a plaintext expense with no receipt on 06.10 as one without a receipt', () => {
    fixture();
    const typed = recordExpense(deps, {
      user,
      text: '450 кофе',
      sourceKey: 'tg:1001:50',
      occurredAt: new Date('2026-10-06T08:30:00Z'),
      now: NOW,
    });
    expect(typed.kind).toBe('recorded');

    const week = open(ledgerPeriodItems(deps, { user, ledgerId, range: WEEK, now: NOW }));

    expect(week.withoutReceipt).toBe(1);
  });

  it("leaves out another member's receipt in a shared ledger", () => {
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
    const food = categoryOf(shared, 'groceries');
    receipt(user, '2026-10-05T09:00:00Z', food, [['Хлеб', 7999]]);
    receipt(other, '2026-10-06T09:00:00Z', food, [['Сыр', 50000]]);

    const mine = open(ledgerPeriodItems(deps, { user, ledgerId: shared, range: WEEK, now: NOW }));
    const theirs = open(
      ledgerPeriodItems(deps, { user: other, ledgerId: shared, range: WEEK, now: NOW }),
    );

    expect(mine.groups.flatMap((g) => g.items.map((i) => i.name))).toEqual(['Хлеб']);
    expect(mine.withoutReceipt).toBe(0);
    expect(theirs.groups.flatMap((g) => g.items.map((i) => i.name))).toEqual(['Сыр']);
  });

  it('answers undefined for a ledger the user is not in, or a range after today', () => {
    fixture();
    const nextWeek = weekOf('2026-10-12' as LocalDate);

    expect(ledgerPeriodItems(deps, { user: other, ledgerId, range: WEEK, now: NOW })).toBe(
      undefined,
    );
    expect(ledgerPeriodItems(deps, { user, ledgerId, range: nextWeek, now: NOW })).toBe(undefined);
  });

  it('reads a sealed ledger as locked, then from the folded receipts once unlocked', async () => {
    fixture();
    await sealPersonalLedger(deps, user, NOW);
    deps.keys.lock(ledgerId);

    expect(isLocked(ledgerPeriodItems(deps, { user, ledgerId, range: WEEK, now: NOW }))).toBe(true);

    await unlockPersonalLedger(deps, user, NOW);
    const week = open(ledgerPeriodItems(deps, { user, ledgerId, range: WEEK, now: NOW }));
    expect(shape(week)).toEqual([
      {
        name: 'Еда',
        totals: [61398],
        items: ['Кофе 07.10', 'Молоко 05.10', 'Хлеб 05.10', 'Хлеб 06.10'],
      },
      { name: 'Дом', totals: [39900], items: ['Средство 06.10'] },
    ]);
  });
});

describe('activePeriodItems', () => {
  it('reads one local day of the active ledger: Дом above Еда on 06.10, no Кофе or Сыр', () => {
    fixture();
    const day = '2026-10-06' as LocalDate;

    const items = open(activePeriodItems(deps, { user, range: { from: day, to: day } }));

    expect(shape(items)).toEqual([
      { name: 'Дом', totals: [39900], items: ['Средство 06.10'] },
      { name: 'Еда', totals: [8499], items: ['Хлеб 06.10'] },
    ]);
  });
});
