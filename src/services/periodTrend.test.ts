import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { monthOf, periodKey, weekOf } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import { currentPeriodSummary, ledgerPeriodSummary } from './periodSummary.js';
import { periodTrend } from './periodTrend.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';

// Thursday 15 October, 12:00 in Europe/Belgrade (CEST).
const NOW = new Date('2026-10-15T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let other: User;
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

  add('A', '2026-04-30', 99000, 'RSD', 'groceries');
  add('B', '2026-05-01', 10000, 'RSD', 'groceries');
  add('C', '2026-05-31', 2500, 'RSD', 'cafe');
  // June: nothing. July: only a currency with no rate.
  add('D', '2026-07-10', 1250, 'EUR', 'transport');
  add('E', '2026-08-20', 40000, 'RSD', 'cafe');
  add('F', '2026-09-30', 120000, 'RSD', 'groceries');
  add('G', '2026-09-30', 700, 'EUR', 'cafe');
  add('H', '2026-10-01', 30000, 'RSD', 'transport');
  add('I', '2026-10-15', 4500, 'RSD', null);
});

function add(
  id: string,
  occurredOn: string,
  amountMinor: number,
  currency: CurrencyCode,
  preset: string | null,
) {
  const categoryId =
    preset === null
      ? undefined
      : (db
          .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
          .pluck()
          .get(ledgerId, preset) as CategoryId);
  insertExpenseOrGetExisting(db, {
    id: id as ExpenseId,
    ledgerId,
    createdBy: user.id,
    amountMinor,
    currency,
    description: 'x',
    occurredAt: NOW,
    occurredOn: occurredOn as LocalDate,
    sourceKey: `tg:${id}`,
    createdAt: NOW,
    ...(categoryId === undefined ? {} : { categoryId }),
  });
}

const current = (kind: 'week' | 'month') => {
  const summary = currentPeriodSummary(deps, { user, kind, now: NOW });
  if (isLocked(summary)) throw new Error('a plaintext ledger read as locked');
  return summary.period;
};

describe('periodTrend', () => {
  it('has 6 months, 2026-05 to 2026-10 oldest first, for a month opened on 2026-10-15', () => {
    const trend = periodTrend(deps, { user, ledgerId, period: current('month'), now: NOW });

    expect(trend?.map((point) => [periodKey(point.period), point.totalMinor])).toEqual([
      ['2026-05', 12500],
      ['2026-06', 0],
      ['2026-07', 0],
      ['2026-08', 40000],
      ['2026-09', 120000],
      ['2026-10', 34500],
    ]);
  });

  it('gives each bar the converted total the screen shows after paging to that period', () => {
    const trend = periodTrend(deps, { user, ledgerId, period: current('month'), now: NOW });

    for (const point of trend ?? []) {
      const summary = ledgerPeriodSummary(deps, { user, ledgerId, period: point.period, now: NOW });
      if (summary === undefined || isLocked(summary)) throw new Error('readable period expected');
      const [first] = summary.currencies;
      expect(point.totalMinor).toBe(first?.currency === 'RSD' ? first.totalMinor : 0);
    }
    expect(trend).toHaveLength(6);
  });

  it('ends at a paged-to period, and counts weeks for a week', () => {
    const august = periodTrend(deps, {
      user,
      ledgerId,
      period: monthOf('2026-08-01' as LocalDate),
      now: NOW,
    });
    const weeks = periodTrend(deps, { user, ledgerId, period: current('week'), now: NOW });

    expect(august?.map((point) => periodKey(point.period))).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
    expect(august?.map((point) => point.totalMinor)).toEqual([0, 99000, 12500, 0, 0, 40000]);
    expect(weeks?.map((point) => point.period)).toEqual(
      ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'].map(
        (monday) => weekOf(monday as LocalDate),
      ),
    );
    expect(weeks?.map((point) => point.totalMinor)).toEqual([0, 0, 0, 150000, 0, 4500]);
  });

  it('is undefined for a user who is not a member', () => {
    expect(
      periodTrend(deps, { user: other, ledgerId, period: current('month'), now: NOW }),
    ).toBeUndefined();
  });
});
