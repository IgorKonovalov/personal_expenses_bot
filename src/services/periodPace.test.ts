import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../db/expenses.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { monthOf, weekOf } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import { periodPace } from './periodPace.js';
import { ledgerPeriodSummary } from './periodSummary.js';
import { periodTrend } from './periodTrend.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';

// Thursday 15 October, 12:00 in Europe/Belgrade (CEST).
const NOW = new Date('2026-10-15T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let ledgerId: LedgerId;

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

function add(
  id: string,
  occurredOn: string,
  amountMinor: number,
  currency: CurrencyCode,
  occurredAt: Date = NOW,
) {
  insertExpenseOrGetExisting(db, {
    id: id as ExpenseId,
    ledgerId,
    createdBy: user.id,
    amountMinor,
    currency,
    description: 'x',
    occurredAt,
    occurredOn: occurredOn as LocalDate,
    sourceKey: `tg:${id}`,
    createdAt: occurredAt,
    categoryId: db
      .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
      .pluck()
      .get(ledgerId, 'groceries') as CategoryId,
  });
}

// An NBS list holding only EUR at 117.4993, in force on `day`.
function storeEurRate(day: string) {
  const date = day as LocalDate;
  const fetchedAt = new Date(`${day}T08:00:00Z`);
  storeFxList(
    db,
    { listDate: date, listNumber: 1, rates: [{ currency: 'EUR', unit: 1, middleE4: 1174993 }] },
    fetchedAt,
  );
  setFxDay(db, date, date, fetchedAt);
}

const october = monthOf('2026-10-15' as LocalDate);

describe('periodPace', () => {
  it('has 31 days, 15 points through 15 October and 30 for all of September', () => {
    add('A', '2026-10-03', 1000, 'RSD');
    add('B', '2026-09-30', 2000, 'RSD');

    const pace = periodPace(deps, { user, ledgerId, period: october, now: NOW });

    expect(pace?.running).toBe(true);
    expect(pace?.current.days).toBe(31);
    expect(pace?.current.points).toEqual([0, 0, ...Array<number>(13).fill(1000)]);
    expect(pace?.current.through).toBe('2026-10-15');
    expect(pace?.previous.days).toBe(30);
    expect(pace?.previous.points).toEqual([...Array<number>(29).fill(0), 2000]);
  });

  it('counts an expense dated 1 October, recorded at 00:30 in Belgrade, on October day 1', () => {
    add('A', '2026-10-01', 4500, 'RSD', new Date('2026-09-30T22:30:00Z'));

    const pace = periodPace(deps, { user, ledgerId, period: october, now: NOW });

    expect(pace?.current.points[0]).toBe(4500);
    expect(pace?.previous.points.at(-1)).toBe(0);
  });

  it('ends at the totals the pie and the previous trend bar show, converted EUR included', () => {
    storeEurRate('2026-10-02');
    storeEurRate('2026-09-28');
    add('A', '2026-10-02', 1250, 'EUR');
    add('B', '2026-10-05', 30000, 'RSD');
    add('C', '2026-09-28', 333, 'EUR');
    add('D', '2026-09-10', 70000, 'RSD');

    const pace = periodPace(deps, { user, ledgerId, period: october, now: NOW });
    const summary = ledgerPeriodSummary(deps, { user, ledgerId, period: october, now: NOW });
    const trend = periodTrend(deps, { user, ledgerId, period: october, now: NOW });

    if (summary === undefined || isLocked(summary)) throw new Error('a summary expected');
    // 12.50 EUR at 117.4993 is 1 468.74 RSD; 3.33 EUR is 391.27 RSD.
    expect(pace?.current.points.at(-1)).toBe(146874 + 30000);
    expect(pace?.current.points.at(-1)).toBe(summary.currencies[0]?.totalMinor);
    expect(pace?.previous.points.at(-1)).toBe(39127 + 70000);
    expect(pace?.previous.points.at(-1)).toBe(trend?.at(-2)?.totalMinor);
  });

  it('leaves an expense dated after today out of the running series', () => {
    add('A', '2026-10-10', 1000, 'RSD');
    add('B', '2026-10-20', 9000, 'RSD');

    const pace = periodPace(deps, { user, ledgerId, period: october, now: NOW });

    expect(pace?.current.points).toHaveLength(15);
    expect(pace?.current.points.at(-1)).toBe(1000);
  });

  it('runs a past August through all 31 days, against all of July', () => {
    add('A', '2026-08-31', 500, 'RSD');

    const august = monthOf('2026-08-01' as LocalDate);
    const pace = periodPace(deps, { user, ledgerId, period: august, now: NOW });

    expect(pace?.running).toBe(false);
    expect(pace?.current.points).toHaveLength(31);
    expect(pace?.current.points.at(-1)).toBe(500);
    expect(pace?.current.through).toBe('2026-08-31');
    expect(pace?.previous.points).toHaveLength(31);
  });

  it('has 7 days for a week', () => {
    const pace = periodPace(deps, {
      user,
      ledgerId,
      period: weekOf('2026-10-15' as LocalDate),
      now: NOW,
    });

    expect(pace?.current.days).toBe(7);
    // Monday 12 to Thursday 15 October.
    expect(pace?.current.points).toHaveLength(4);
    expect(pace?.previous.points).toHaveLength(7);
  });

  it('is undefined for a period after today', () => {
    const november = monthOf('2026-11-01' as LocalDate);

    expect(periodPace(deps, { user, ledgerId, period: november, now: NOW })).toBeUndefined();
  });
});
