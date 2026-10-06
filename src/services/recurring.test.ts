import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import type { ExpenseId } from '../db/expenses.js';
import { runMigrations } from '../db/migrate.js';
import { findRule, type RuleId } from '../db/recurring.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { createRuleFromExpense, dueRules, fireRule } from './recurring.js';

const CREATED = new Date('2026-10-02T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let logLines: string[];
let alice: User;
let bob: User;
let n: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, CREATED);
  n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => CREATED),
  };
  const provision = (externalId: string) =>
    provisionUser(deps, {
      provider: 'telegram',
      externalId,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: CREATED,
    }).user;
  alice = provision('1001');
  bob = provision('1002');
});

function record(user: User, text: string, occurredAt: Date, key: string): ExpenseId {
  const recorded = recordExpense(deps, { user, text, sourceKey: key, occurredAt, now: occurredAt });
  if (recorded.kind !== 'recorded') throw new Error('setup failed');
  return recorded.expense.id;
}

// `45000 аренда` sent on 1 October, repeated monthly on 2 October.
function rentRule(): RuleId {
  const expenseId = record(alice, '45000 аренда', new Date('2026-10-01T10:00:00Z'), 'tg:1001:1');
  const made = createRuleFromExpense(deps, { user: alice, expenseId, choice: 'm', now: CREATED });
  if (made.kind !== 'created') throw new Error('rule not made');
  return made.rule.id;
}

function recurringExpenses(): unknown[] {
  return db
    .prepare(
      `SELECT amount_minor, currency, description, occurred_on, created_by, source_key
         FROM expenses WHERE source_key LIKE 'rec:%' ORDER BY occurred_on`,
    )
    .all();
}

function tick(at: string) {
  const now = new Date(at);
  return dueRules(deps, now).map((due) => fireRule(deps, due, now));
}

describe('createRuleFromExpense', () => {
  it('makes an auto rule from the expense, due the next 1st after today', () => {
    const id = rentRule();

    expect(findRule(db, id)).toMatchObject({
      kind: 'expense',
      mode: 'auto',
      userId: alice.id,
      template: { amountMinor: 4500000, currency: 'RSD', description: 'аренда' },
      schedule: { kind: 'monthly', day: 1 },
      nextDueOn: '2026-11-01',
    });
  });

  it('returns the live rule on a second tap of the same schedule', () => {
    const expenseId = record(alice, '45000 аренда', new Date('2026-10-01T10:00:00Z'), 'tg:1001:1');
    const first = createRuleFromExpense(deps, {
      user: alice,
      expenseId,
      choice: 'm',
      now: CREATED,
    });
    const second = createRuleFromExpense(deps, {
      user: alice,
      expenseId,
      choice: 'm',
      now: CREATED,
    });

    expect(first).toMatchObject({ kind: 'created', created: true });
    expect(second).toMatchObject({ kind: 'created', created: false });
    if (first.kind === 'created' && second.kind === 'created') {
      expect(second.rule.id).toBe(first.rule.id);
    }
    expect(db.prepare('SELECT COUNT(*) FROM recurring_rules').pluck().get()).toBe(1);
  });

  it('refuses anyone but the author', () => {
    const expenseId = record(alice, '45000 аренда', new Date('2026-10-01T10:00:00Z'), 'tg:1001:1');

    expect(
      createRuleFromExpense(deps, { user: bob, expenseId, choice: 'm', now: CREATED }),
    ).toEqual({ kind: 'forbidden' });
  });
});

describe('firing a monthly rule', () => {
  it('records nothing at 08:59 CET on the 1st', () => {
    rentRule();

    expect(tick('2026-11-01T07:59:00Z')).toEqual([]);
    expect(recurringExpenses()).toEqual([]);
  });

  it('records the rent at 09:00 CET on the 1st and moves to 1 December', () => {
    const id = rentRule();

    tick('2026-11-01T08:00:00Z');

    expect(recurringExpenses()).toEqual([
      {
        amount_minor: 4500000,
        currency: 'RSD',
        description: 'аренда',
        occurred_on: '2026-11-01',
        created_by: alice.id,
        source_key: `rec:${id}:2026-11-01`,
      },
    ]);
    expect(findRule(db, id)?.nextDueOn).toBe('2026-12-01');
    expect(db.prepare('SELECT rule_id, due_on, outcome FROM recurring_occurrences').all()).toEqual([
      { rule_id: id, due_on: '2026-11-01', outcome: 'recorded' },
    ]);
  });

  it('records once when two ticks run the same occurrence', () => {
    rentRule();
    const now = new Date('2026-11-01T08:00:00Z');
    // Both ticks read the rule as due before either fires.
    const first = dueRules(deps, now);
    const second = dueRules(deps, now);

    const results = [...first, ...second].map((due) => fireRule(deps, due, now));

    expect(recurringExpenses()).toHaveLength(1);
    expect(results.map((r) => r?.fired.length)).toEqual([1, 0]);
    expect(tick('2026-11-01T08:00:00Z')).toEqual([]);
    expect(recurringExpenses()).toHaveLength(1);
  });

  it('logs ids and the outcome, never the amount or description', () => {
    rentRule();
    logLines.length = 0;

    tick('2026-11-01T08:00:00Z');

    expect(logLines.some((line) => line.includes('recurring occurrence'))).toBe(true);
    for (const line of logLines) {
      expect(line).not.toContain('аренда');
      expect(line).not.toContain('4500000');
    }
  });
});
