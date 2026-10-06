import { beforeEach, describe, expect, it } from 'vitest';
import { setBudgetLimit, setBudgetStartDay } from '../db/budgets.js';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../db/expenses.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import type { Ledger } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { claimSummaryPush } from '../db/summaryPushes.js';
import { setPushOn, type User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import {
  claimSummary,
  dueSummaries,
  periodReport,
  turnSummaryPushOff,
  type PeriodReport,
} from './periodReport.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

const NOW = new Date('2026-10-01T07:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let ledger: Ledger;
let n: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  n = 0;
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
  ledger = provisioned.ledger;
});

function add(
  occurredOn: string,
  amountMinor: number,
  preset: string | null,
  currency: CurrencyCode = 'RSD',
) {
  const categoryId =
    preset === null
      ? undefined
      : (db
          .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
          .pluck()
          .get(ledger.id, preset) as CategoryId);
  const id = `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  insertExpenseOrGetExisting(db, {
    id: id as ExpenseId,
    ledgerId: ledger.id,
    createdBy: user.id,
    amountMinor,
    currency,
    description: 'синтетика',
    occurredAt: new Date(`${occurredOn}T10:00:00Z`),
    occurredOn: occurredOn as LocalDate,
    sourceKey: `test:${id}`,
    createdAt: NOW,
    ...(categoryId === undefined ? {} : { categoryId }),
  });
}

const september = { kind: 'month' as const, from: '2026-09-01', to: '2026-09-30' } as {
  kind: 'month';
  from: LocalDate;
  to: LocalDate;
};
const august = { from: '2026-08-01' as LocalDate, to: '2026-08-31' as LocalDate };

function report(): PeriodReport {
  const result = periodReport(deps, {
    ledger,
    readerId: user.id,
    period: september,
    previous: august,
  });
  if (isLocked(result)) throw new Error('locked');
  return result;
}

describe('periodReport', () => {
  it('compares the converted total and each category with the period before', () => {
    add('2026-08-10', 930000, 'cafe');
    add('2026-08-12', 70000, null);
    add('2026-09-10', 1240000, 'cafe');
    add('2026-09-12', 70000, null);
    add('2026-09-30', 1000, 'transport');

    const { converted } = report();

    expect(converted?.totalMinor).toBe(1311000);
    expect(converted?.change).toEqual({ kind: 'change', deltaMinor: 311000, percent: 31 });
    expect(converted?.lines.map((l) => [l.name, l.amountMinor, l.change])).toEqual([
      ['Кафе и рестораны', 1240000, { kind: 'change', deltaMinor: 310000, percent: 33 }],
      [null, 70000, { kind: 'change', deltaMinor: 0, percent: 0 }],
      ['Транспорт', 1000, { kind: 'new' }],
    ]);
  });

  it('keeps a currency with no rate in its own block, and converts one with a rate', () => {
    // 117.5 RSD per EUR on 10 September.
    storeFxList(
      db,
      {
        listDate: '2026-09-10' as LocalDate,
        listNumber: 175,
        rates: [{ currency: 'EUR', unit: 1, middleE4: 1175000 }],
      },
      NOW,
    );
    setFxDay(db, '2026-09-10' as LocalDate, '2026-09-10' as LocalDate, NOW);
    add('2026-09-10', 1000, 'cafe', 'EUR');
    add('2026-09-10', 5000, 'cafe', 'USD');

    const result = report();

    expect(result.converted?.totalMinor).toBe(117500);
    expect(result.convertedFrom).toEqual([{ currency: 'EUR', amountMinor: 1000 }]);
    expect(result.unconverted.map((c) => [c.currency, c.totalMinor])).toEqual([['USD', 5000]]);
  });

  it('ends the limit and ranks the top 3 by converted amount, leaving out one with no rate', () => {
    setBudgetLimit(db, ledger.id, { limitMinor: 6000000, currency: 'RSD' }, NOW);
    storeFxList(
      db,
      {
        listDate: '2026-09-10' as LocalDate,
        listNumber: 175,
        rates: [{ currency: 'EUR', unit: 1, middleE4: 1175000 }],
      },
      NOW,
    );
    setFxDay(db, '2026-09-10' as LocalDate, '2026-09-10' as LocalDate, NOW);
    add('2026-09-10', 1000, 'cafe', 'EUR');
    add('2026-09-11', 100000, 'cafe');
    add('2026-09-12', 100000, 'cafe');
    add('2026-09-13', 50000, 'cafe');
    add('2026-09-14', 999999, 'cafe', 'USD');

    const result = report();

    expect(result.budget).toEqual({
      currency: 'RSD',
      limitMinor: 6000000,
      // 117500 + 100000 + 100000 + 50000; the USD one has no rate.
      spentMinor: 367500,
      converted: true,
    });
    expect(
      result.top.map((e) => [
        e.occurredOn,
        e.convertedMinor,
        e.money.currency,
        e.money.amountMinor,
      ]),
    ).toEqual([
      ['2026-09-10', 117500, 'EUR', 1000],
      ['2026-09-11', 100000, 'RSD', 100000],
      ['2026-09-12', 100000, 'RSD', 100000],
    ]);
  });

  it('reads a sealed ledger only while it is unlocked', async () => {
    add('2026-09-10', 1240000, 'cafe');
    await sealPersonalLedger(deps, user, NOW);

    expect(
      isLocked(
        periodReport(deps, { ledger, readerId: user.id, period: september, previous: august }),
      ),
    ).toBe(true);

    await unlockPersonalLedger(deps, user, NOW);
    expect(report().converted?.totalMinor).toBe(1240000);
  });
});

describe('dueSummaries and claimSummary', () => {
  it('is due from 09:00 local on the 1st with the closed month and the one before it', () => {
    expect(dueSummaries(deps, new Date('2026-10-01T06:59:59Z'))).toEqual([]);

    const [due] = dueSummaries(deps, NOW);

    expect(due).toMatchObject({
      push: 'monthly',
      kind: 'period',
      period: { kind: 'month', from: '2026-09-01', to: '2026-09-30' },
      previous: { from: '2026-08-01', to: '2026-08-31' },
      periodKey: '2026-09',
    });
  });

  it('is the closed payday period, keyed by its first day, for a budget starting on the 15th', () => {
    setBudgetStartDay(db, ledger.id, { startDay: 15, currency: 'RSD' }, NOW);

    expect(dueSummaries(deps, NOW)).toEqual([]);
    expect(dueSummaries(deps, new Date('2026-10-15T06:59:00Z'))).toEqual([]);
    const [due] = dueSummaries(deps, new Date('2026-10-15T07:00:00Z'));

    expect(due).toMatchObject({
      kind: 'period',
      period: { kind: 'budget', from: '2026-09-15', to: '2026-10-14' },
      previous: { from: '2026-08-15', to: '2026-09-14' },
      periodKey: '2026-09-15',
    });
  });

  it('is the calendar month for a budget starting on the 1st', () => {
    setBudgetStartDay(db, ledger.id, { startDay: 1, currency: 'RSD' }, NOW);

    expect(dueSummaries(deps, NOW)[0]).toMatchObject({
      period: { kind: 'month', from: '2026-09-01', to: '2026-09-30' },
      periodKey: '2026-09',
    });
  });

  it('is not due once claimed, nor with the push off', () => {
    claimSummaryPush(db, {
      ledgerId: ledger.id,
      kind: 'period',
      periodKey: '2026-09',
      outcome: 'sent',
      createdAt: NOW,
    });
    expect(dueSummaries(deps, NOW)).toEqual([]);

    db.prepare('DELETE FROM summary_pushes').run();
    setPushOn(db, user.id, 'monthly', false);
    expect(dueSummaries(deps, NOW)).toEqual([]);
  });

  it('claims `sent` for a period with expenses, once', () => {
    add('2026-09-10', 1000, 'cafe');
    const [due] = dueSummaries(deps, NOW);
    if (due === undefined) throw new Error('not due');

    expect(claimSummary(deps, due, NOW)).toBe('sent');
    expect(claimSummary(deps, due, NOW)).toBeUndefined();
  });

  it('claims `empty` for a period with none', () => {
    add('2026-08-10', 1000, 'cafe');
    const [due] = dueSummaries(deps, NOW);
    if (due === undefined) throw new Error('not due');

    expect(claimSummary(deps, due, NOW)).toBe('empty');
  });

  it('turns a push off once', () => {
    expect(turnSummaryPushOff(deps, user, 'monthly')).toBe(true);
    expect(turnSummaryPushOff(deps, user, 'monthly')).toBe(false);
    expect(dueSummaries(deps, NOW)).toEqual([]);
  });
});
