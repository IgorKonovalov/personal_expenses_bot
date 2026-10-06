import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import type { Expense } from '../db/expenses.js';
import { runMigrations } from '../db/migrate.js';
import { setBudgetLimit } from '../db/budgets.js';
import { markOnboarded, setTipsOff, type User } from '../db/users.js';
import { insertTipShown, listTipsShown } from '../db/userTips.js';
import { createLogger } from '../logger.js';
import { startFlow } from './flowSessions.js';
import { createLedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense } from './recordExpense.js';
import { switchTips, takeTip, tipsOn } from './tips.js';

// 23:30 on 1 October in Belgrade (CEST, UTC+2).
const LATE = new Date('2026-10-01T21:30:00Z');
// 23:59 the same local day.
const LAST_MINUTE = new Date('2026-10-01T21:59:00Z');
// 00:00 on 2 October local.
const MIDNIGHT = new Date('2026-10-01T22:00:00Z');

let db: Db;
let n: number;
let user: User;

function deps() {
  return {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => LATE),
  };
}

function record(text: string, key: string, now: Date): Expense {
  const result = recordExpense(deps(), { user, text, sourceKey: key, occurredAt: now, now });
  if (result.kind !== 'recorded') throw new Error(`setup: ${result.kind}`);
  return result.expense;
}

function offer(expense: Expense | undefined, now: Date, privateChat = true) {
  return takeTip(deps(), {
    user,
    trigger: 'expenseRecorded',
    privateChat,
    ...(expense === undefined ? {} : { expense }),
    now,
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, LATE);
  n = 0;
  user = provisionUser(deps(), {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: LATE,
  }).user;
  markOnboarded(db, user.id, LATE);
});

describe('takeTip', () => {
  it('records the tip it offers, with the currencies its copy may name', () => {
    const expense = record('12 EUR xyzzy', 'tg:1:1', LATE);

    expect(offer(expense, LATE)).toEqual({
      key: 'tipOther',
      view: { ledgerCurrency: 'RSD', expenseCurrency: 'EUR' },
    });
    expect(listTipsShown(db, user.id)).toEqual([{ tip: 'tipOther', shownAt: LATE }]);
  });

  it('caps tips at one per local day: 23:59 is blocked, 00:00 gets the next one', () => {
    const expense = record('12 EUR xyzzy', 'tg:1:1', LATE);
    expect(offer(expense, LATE)?.key).toBe('tipOther');

    expect(offer(expense, LAST_MINUTE)).toBeUndefined();
    expect(offer(expense, MIDNIGHT)?.key).toBe('tipForeign');
  });

  it("shows a tip held back by the cap on the next day's first matching trigger", () => {
    // A /today tip uses the day's slot; the expense's tip waits for tomorrow.
    expect(
      takeTip(deps(), { user, trigger: 'todayShown', privateChat: true, now: LATE })?.key,
    ).toBe('tipPastDate');
    const expense = record('450 кофе', 'tg:1:1', LATE);
    expect(offer(expense, LAST_MINUTE)).toBeUndefined();

    const next = record('300 такси', 'tg:1:2', MIDNIGHT);
    expect(offer(next, MIDNIGHT)?.key).toBe('tipFirstExpense');
  });

  it('offers nothing with tips off, and again once they are back on', () => {
    const expense = record('450 кофе', 'tg:1:1', LATE);
    setTipsOff(db, user.id, true);
    expect(offer(expense, LATE)).toBeUndefined();
    expect(takeTip(deps(), { user, trigger: 'todayShown', privateChat: true, now: LATE })).toBe(
      undefined,
    );
    expect(tipsOn(deps(), user)).toBe(false);

    expect(switchTips(deps(), user, true)).toBe(true);
    expect(offer(expense, LATE)?.key).toBe('tipFirstExpense');
  });

  it('offers nothing to a user not onboarded yet', () => {
    db.prepare('UPDATE users SET onboarded_at = NULL').run();
    expect(offer(record('450 кофе', 'tg:1:1', LATE), LATE)).toBeUndefined();
    expect(listTipsShown(db, user.id)).toEqual([]);
  });

  it('offers nothing while a category-rename flow is pending', () => {
    const expense = record('450 кофе', 'tg:1:1', LATE);
    startFlow(
      deps(),
      user,
      { kind: 'categoryRename', ledgerId: expense.ledgerId, categoryId: 1 as CategoryId },
      LATE,
    );

    expect(offer(expense, LATE)).toBeUndefined();
    expect(listTipsShown(db, user.id)).toEqual([]);
  });

  it('offers nothing outside a private chat', () => {
    expect(offer(record('450 кофе', 'tg:1:1', LATE), LATE, false)).toBeUndefined();
  });

  it('counts the ledger: tipGroup on the 20th expense once the earlier tips are seen', () => {
    const LONG_AGO = new Date('2026-09-01T10:00:00Z');
    for (const key of ['tipOther', 'tipForeign', 'tipReceipt', 'tipFirstExpense'] as const) {
      insertTipShown(db, user.id, key, LONG_AGO);
    }
    let last: Expense | undefined;
    for (let i = 1; i <= 19; i++) last = record('450 кофе', `tg:1:${i}`, LATE);
    expect(offer(last, LATE)).toBeUndefined();

    last = record('450 кофе', 'tg:1:20', LATE);
    expect(offer(last, LATE)?.key).toBe('tipGroup');
  });

  it('reads the budget limit for /month', () => {
    const monthTip = () =>
      takeTip(deps(), { user, trigger: 'monthShown', privateChat: true, now: LATE });
    const ledgerId = record('450 кофе', 'tg:1:1', LATE).ledgerId;
    setBudgetLimit(db, ledgerId, { limitMinor: 100_000, currency: 'RSD' }, LATE);
    expect(monthTip()).toBeUndefined();

    db.prepare('DELETE FROM ledger_budgets').run();
    expect(monthTip()?.key).toBe('tipBudget');
  });
});
