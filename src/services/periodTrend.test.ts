import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { periodChart, periodTrend } from './periodTrend.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';

// Counts the reads periodChart makes, still running the real summary.
vi.mock('./periodSummary.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./periodSummary.js')>();
  return { ...original, ledgerPeriodSummary: vi.fn(original.ledgerPeriodSummary) };
});

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

describe('periodChart', () => {
  const october = monthOf('2026-10-01' as LocalDate);
  const groceries = 'groceries';

  // The plan's month ledger: Еда is groceries, Транспорт transport, Кафе cafe.
  beforeEach(() => {
    db.prepare('DELETE FROM expenses').run();
    add('S1', '2026-09-10', 60000, 'RSD', groceries);
    add('S2', '2026-09-20', 40000, 'RSD', groceries);
    add('S3', '2026-09-20', 40000, 'RSD', 'transport');
    add('O1', '2026-10-02', 120000, 'RSD', groceries);
    add('O2', '2026-10-15', 30000, 'RSD', 'transport');
    add('O3', '2026-10-01', 5000, 'RSD', 'cafe');
    vi.mocked(ledgerPeriodSummary).mockClear();
  });

  const changesOf = (now: Date, period = october) => {
    const chart = periodChart(deps, { user, ledgerId, period, now });
    return {
      chart,
      lines: chart?.comparison?.lines.map((line) => [line.amountMinor, line.change]),
    };
  };

  it('compares a past October whole with September', () => {
    const { chart, lines } = changesOf(new Date('2026-11-03T10:00:00Z'));

    expect(lines).toEqual([
      [120000, { kind: 'change', deltaMinor: 20000, percent: 20 }],
      [30000, { kind: 'change', deltaMinor: -10000, percent: -25 }],
      [5000, { kind: 'new' }],
    ]);
    // 155000 against 140000: 10.71% rounds to 11.
    expect(chart?.comparison?.total).toEqual({ kind: 'change', deltaMinor: 15000, percent: 11 });
    expect(chart?.comparison?.window).toEqual(monthOf('2026-09-01' as LocalDate));
    expect(chart?.comparison?.whole).toBe(true);
  });

  it('compares a running October on the 15th with 1–15 September', () => {
    const { chart, lines } = changesOf(NOW);

    expect(chart?.comparison?.window).toEqual({
      kind: 'month',
      from: '2026-09-01',
      to: '2026-09-15',
    });
    expect(chart?.comparison?.whole).toBe(false);
    expect(lines).toEqual([
      [120000, { kind: 'change', deltaMinor: 60000, percent: 100 }],
      [30000, { kind: 'new' }],
      [5000, { kind: 'new' }],
    ]);
    // 155000 against 60000: 158.33%.
    expect(chart?.comparison?.total).toEqual({ kind: 'change', deltaMinor: 95000, percent: 158 });
  });

  it('clips a running window on 30 March to the whole of February', () => {
    const march = monthOf('2026-03-01' as LocalDate);
    add('M1', '2026-03-10', 10000, 'RSD', groceries);

    const { chart } = changesOf(new Date('2026-03-30T10:00:00Z'), march);

    expect(chart?.comparison?.window).toEqual(monthOf('2026-02-01' as LocalDate));
    expect(chart?.comparison?.whole).toBe(true);
  });

  it('compares a week on Wednesday 7 October with 28–30 September', () => {
    const week = weekOf('2026-10-07' as LocalDate);
    add('W1', '2026-10-06', 1000, 'RSD', groceries);

    const { chart } = changesOf(new Date('2026-10-07T10:00:00Z'), week);

    expect(chart?.comparison?.window).toEqual({
      kind: 'week',
      from: '2026-09-28',
      to: '2026-09-30',
    });
    expect(chart?.comparison?.whole).toBe(false);
  });

  it('leaves out a category spent on only in the window', () => {
    add('S4', '2026-09-05', 9000, 'RSD', 'telecom');

    const { lines } = changesOf(NOW);

    expect(lines?.map(([amount]) => amount)).toEqual([120000, 30000, 5000]);
  });

  it('reads 6 summaries for a past period and 7 for a running one', () => {
    changesOf(new Date('2026-11-03T10:00:00Z'));
    expect(ledgerPeriodSummary).toHaveBeenCalledTimes(6);

    vi.mocked(ledgerPeriodSummary).mockClear();
    changesOf(NOW);
    expect(ledgerPeriodSummary).toHaveBeenCalledTimes(7);
  });

  it("carries each period's converted lines by category id, still from 6 reads", () => {
    add('S5', '2026-09-30', 2500, 'RSD', null);
    vi.mocked(ledgerPeriodSummary).mockClear();
    const { chart } = changesOf(new Date('2026-11-03T10:00:00Z'));

    expect(ledgerPeriodSummary).toHaveBeenCalledTimes(6);
    expect(chart?.trend.map((point) => point.lines.length)).toEqual([0, 0, 0, 0, 3, 3]);
    // September: groceries, transport, then the uncategorized line, id null.
    expect(
      chart?.trend[4]?.lines.map((line) => [line.categoryId === null, line.amountMinor]),
    ).toEqual([
      [false, 100000],
      [false, 40000],
      [true, 2500],
    ]);
    expect(chart?.trend.at(-1)?.lines.map((line) => line.amountMinor)).toEqual([
      120000, 30000, 5000,
    ]);
    const groceriesId = chart?.trend.at(-1)?.lines[0]?.categoryId;
    expect(chart?.trend[4]?.lines[0]?.categoryId).toBe(groceriesId);
  });
});
