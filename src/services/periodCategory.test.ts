import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { monthOf, weekOf } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import { categoryExpenses, pickerCategories } from './periodCategory.js';
import { ledgerPeriodSummary } from './periodSummary.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

// Wednesday 30 September, 12:00 local (CEST).
const NOW = new Date('2026-09-30T10:00:00Z');
const SEPTEMBER = monthOf('2026-09-30' as LocalDate);

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let other: User;
let ledgerId: LedgerId;
let otherLedgerId: LedgerId;

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
  const second = provision('1002');
  other = second.user;
  otherLedgerId = second.ledger.id;
});

function categoryOf(preset: string, ledger: LedgerId = ledgerId): CategoryId {
  return db
    .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
    .pluck()
    .get(ledger, preset) as CategoryId;
}

function add(
  id: string,
  occurredOn: string,
  amountMinor: number,
  currency: CurrencyCode,
  preset: string | null,
  occurredAt: Date = NOW,
) {
  insertExpenseOrGetExisting(db, {
    id: id as ExpenseId,
    ledgerId,
    createdBy: user.id,
    amountMinor,
    currency,
    description: `d-${id}`,
    occurredAt,
    occurredOn: occurredOn as LocalDate,
    sourceKey: `tg:${id}`,
    createdAt: NOW,
    ...(preset === null ? {} : { categoryId: categoryOf(preset) }),
  });
}

// The NBS middle rate of EUR on 2026-09-28: 117.4993.
function storeSept28EurRate() {
  const day = '2026-09-28' as LocalDate;
  const fetchedAt = new Date('2026-09-28T08:00:00Z');
  storeFxList(
    db,
    { listDate: day, listNumber: 184, rates: [{ currency: 'EUR', unit: 1, middleE4: 1174993 }] },
    fetchedAt,
  );
  setFxDay(db, day, day, fetchedAt);
}

// A plaintext ledger never reads as locked.
function plain<T extends object>(value: T | Locked | undefined): T | undefined {
  if (isLocked(value)) throw new Error('a plaintext ledger read as locked');
  return value;
}

function september() {
  const summary = plain(ledgerPeriodSummary(deps, { user, ledgerId, period: SEPTEMBER, now: NOW }));
  if (summary === undefined) throw new Error('September expected');
  return summary;
}

function list(categoryId: CategoryId | null, period = SEPTEMBER) {
  return plain(categoryExpenses(deps, { user, ledgerId, period, categoryId, now: NOW }));
}

describe('pickerCategories', () => {
  it('gives Продукты and Кафе once each when Продукты is also in a currency with no rate', () => {
    add('A', '2026-09-10', 120000, 'RSD', 'groceries');
    add('B', '2026-09-11', 45000, 'RSD', 'cafe');
    add('C', '2026-09-12', 500000, 'KZT', 'groceries');

    expect(pickerCategories(september()).map((c) => c.name)).toEqual([
      'Продукты',
      'Кафе и рестораны',
    ]);
  });

  it('appends the categories only an unconverted block holds, then the uncategorized last', () => {
    add('A', '2026-09-10', 120000, 'RSD', 'groceries');
    add('B', '2026-09-11', 45000, 'RSD', 'cafe');
    // Larger than Кафе, so the digest lists it second; the picker puts it last.
    add('C', '2026-09-12', 90000, 'RSD', null);
    add('D', '2026-09-13', 500000, 'KZT', 'transport');
    // No rate is stored, so KZT and USD both stay in their own blocks, alphabetically.
    add('E', '2026-09-14', 100, 'USD', 'other');

    expect(pickerCategories(september())).toEqual([
      { id: categoryOf('groceries'), name: 'Продукты' },
      { id: categoryOf('cafe'), name: 'Кафе и рестораны' },
      { id: categoryOf('transport'), name: 'Транспорт' },
      { id: categoryOf('other'), name: 'Другое' },
      { id: null, name: null },
    ]);
  });
});

describe('categoryExpenses', () => {
  it("lists the category's live expenses in the period, newest first", () => {
    add('A', '2026-08-31', 10000, 'RSD', 'groceries');
    add('B', '2026-09-01', 20000, 'RSD', 'groceries');
    add('C', '2026-09-15', 30000, 'RSD', 'groceries', new Date('2026-09-15T08:00:00Z'));
    add('D', '2026-09-15', 40000, 'RSD', 'groceries', new Date('2026-09-15T09:00:00Z'));
    add('E', '2026-09-20', 50000, 'RSD', 'groceries');
    softDeleteExpense(db, 'E' as ExpenseId, NOW);
    add('F', '2026-09-21', 60000, 'RSD', 'cafe');
    add('G', '2026-09-22', 70000, 'RSD', null);

    expect(list(categoryOf('groceries'))?.expenses).toEqual([
      {
        id: 'D',
        occurredOn: '2026-09-15',
        money: { amountMinor: 40000, currency: 'RSD' },
        description: 'd-D',
      },
      {
        id: 'C',
        occurredOn: '2026-09-15',
        money: { amountMinor: 30000, currency: 'RSD' },
        description: 'd-C',
      },
      {
        id: 'B',
        occurredOn: '2026-09-01',
        money: { amountMinor: 20000, currency: 'RSD' },
        description: 'd-B',
      },
    ]);
    expect(list(null)?.expenses.map((e) => e.id)).toEqual(['G']);
    expect(list(null)?.category).toEqual({ id: null, name: null });
  });

  it("holds header totals equal to the digest's lines for that category", () => {
    storeSept28EurRate();
    add('A', '2026-09-28', 120000, 'RSD', 'groceries');
    // 10.74 EUR at 117.4993 is 1 261.94 RSD.
    add('B', '2026-09-28', 1074, 'EUR', 'groceries');
    add('C', '2026-09-28', 500000, 'KZT', 'groceries');
    add('D', '2026-09-28', 45000, 'RSD', 'cafe');
    add('E', '2026-09-28', 900, 'EUR', 'cafe');

    const groceries = list(categoryOf('groceries'));

    const digestLines = september().currencies.map((block) => ({
      currency: block.currency,
      amountMinor: block.lines.find((line) => line.categoryId === categoryOf('groceries'))
        ?.amountMinor,
    }));
    expect(
      groceries?.blocks.map((b) => ({ currency: b.currency, amountMinor: b.totalMinor })),
    ).toEqual(digestLines);
    expect(digestLines).toEqual([
      { currency: 'RSD', amountMinor: 246194 },
      { currency: 'KZT', amountMinor: 500000 },
    ]);
    expect(groceries?.convertedFrom).toEqual([{ currency: 'EUR', amountMinor: 1074 }]);
  });

  it('is empty for a category every expense moved out of', () => {
    add('A', '2026-09-10', 120000, 'RSD', 'cafe');

    const groceries = list(categoryOf('groceries'));

    expect(groceries?.expenses).toEqual([]);
    expect(groceries?.blocks).toEqual([]);
    expect(groceries?.category).toEqual({ id: categoryOf('groceries'), name: 'Продукты' });
  });

  it("refuses a non-member, a period after today, and another ledger's category", () => {
    add('A', '2026-09-10', 120000, 'RSD', 'groceries');

    expect(
      categoryExpenses(deps, {
        user: other,
        ledgerId,
        period: SEPTEMBER,
        categoryId: categoryOf('groceries'),
        now: NOW,
      }),
    ).toBeUndefined();
    expect(list(categoryOf('groceries'), weekOf('2026-10-05' as LocalDate))).toBeUndefined();
    expect(list(categoryOf('groceries', otherLedgerId))).toBeUndefined();
  });

  it('reads as locked while a sealed ledger is locked, and lists once unlocked', async () => {
    await sealPersonalLedger(deps, other, NOW);
    const recorded = recordExpense(deps, {
      user: other,
      text: '450 кофе',
      sourceKey: 'tg:1002:1',
      occurredAt: NOW,
      now: NOW,
    });
    expect(recorded.kind).toBe('recorded');
    deps.keys.lock(otherLedgerId);
    const input = {
      user: other,
      ledgerId: otherLedgerId,
      period: SEPTEMBER,
      categoryId: categoryOf('cafe', otherLedgerId),
      now: NOW,
    };

    expect(categoryExpenses(deps, input)).toEqual({ kind: 'locked' });

    await unlockPersonalLedger(deps, other, NOW);
    const cafe = categoryExpenses(deps, input);
    expect(isLocked(cafe) ? undefined : cafe?.expenses.map((e) => e.money)).toEqual([
      { amountMinor: 45000, currency: 'RSD' },
    ]);
  });
});
