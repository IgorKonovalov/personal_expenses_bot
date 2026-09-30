import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { monthOf, weekOf } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { currentPeriodSummary, ledgerPeriodSummary } from './periodSummary.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';

// Wednesday 30 September, 12:00 local (CEST).
const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps;
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

  // The plan's fixture ledger, A to H.
  add('A', '2026-08-31', 10000, 'RSD', 'groceries');
  add('B', '2026-09-01', 45000, 'RSD', 'cafe');
  add('C', '2026-09-15', 120000, 'RSD', 'groceries');
  add('D', '2026-09-28', 30000, 'RSD', 'cafe');
  add('E', '2026-09-30', 1250, 'EUR', 'transport');
  add('F', '2026-09-30', 5000, 'RSD', 'cafe');
  softDeleteExpense(db, 'F' as ExpenseId, NOW);
  add('G', '2026-09-27', 20000, 'RSD', 'transport');
  add('H', '2026-09-29', 7000, 'RSD', null);
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

const lines = (s: { lines: readonly { name: string | null; amountMinor: number }[] }) =>
  s.lines.map((line) => [line.name, line.amountMinor]);

describe('currentPeriodSummary', () => {
  it('splits the month per currency and category, the ledger default first', () => {
    const summary = currentPeriodSummary(deps, { user, kind: 'month', now: NOW });

    expect(summary.period).toEqual(monthOf('2026-09-30' as LocalDate));
    expect(summary.currencies.map((c) => [c.currency, c.totalMinor])).toEqual([
      ['RSD', 222000],
      ['EUR', 1250],
    ]);
    const [rsd, eur] = summary.currencies;
    if (rsd === undefined || eur === undefined) throw new Error('two currencies expected');
    expect(lines(rsd)).toEqual([
      ['Продукты', 120000],
      ['Кафе и рестораны', 75000],
      ['Транспорт', 20000],
      [null, 7000],
    ]);
    expect(rsd.lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(222000);
    expect(lines(eur)).toEqual([['Транспорт', 1250]]);
    expect(summary.previous).toEqual(monthOf('2026-08-01' as LocalDate));
    expect(summary.next).toBeUndefined();
  });

  it('covers Monday to Sunday for the week, without Sunday the 27th or undone', () => {
    const summary = currentPeriodSummary(deps, { user, kind: 'week', now: NOW });

    expect(summary.period).toEqual(weekOf('2026-09-28' as LocalDate));
    const [rsd, eur] = summary.currencies;
    expect(rsd?.totalMinor).toBe(37000);
    expect(rsd && lines(rsd)).toEqual([
      ['Кафе и рестораны', 30000],
      [null, 7000],
    ]);
    expect(eur && lines(eur)).toEqual([['Транспорт', 1250]]);
    expect(summary.next).toBeUndefined();
  });
});

describe('ledgerPeriodSummary', () => {
  it('pages to August with September as its next', () => {
    const summary = ledgerPeriodSummary(deps, {
      user,
      ledgerId,
      period: monthOf('2026-08-01' as LocalDate),
      now: NOW,
    });

    expect(summary?.currencies.map((c) => [c.currency, c.totalMinor, lines(c)])).toEqual([
      ['RSD', 10000, [['Продукты', 10000]]],
    ]);
    expect(summary?.next).toEqual(monthOf('2026-09-01' as LocalDate));
    expect(summary?.previous).toEqual(monthOf('2026-07-01' as LocalDate));
  });

  it('refuses a non-member and a period after today', () => {
    expect(
      ledgerPeriodSummary(deps, {
        user: other,
        ledgerId,
        period: monthOf('2026-09-01' as LocalDate),
        now: NOW,
      }),
    ).toBeUndefined();
    expect(
      ledgerPeriodSummary(deps, {
        user,
        ledgerId,
        period: weekOf('2026-10-05' as LocalDate),
        now: NOW,
      }),
    ).toBeUndefined();
  });
});
