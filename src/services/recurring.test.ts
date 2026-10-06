import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { findExpenseBySourceKey, type ExpenseId, type StoredExpense } from '../db/expenses.js';
import { findPersonalLedger, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { findRule, type RuleId } from '../db/recurring.js';
import type { User } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { answerEditFlow, startEdit } from './editExpense.js';
import { createLedgerKeyring, LOCKED, openExpense, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { answerAsk, createRuleFromExpense, dueRules, fireRule } from './recurring.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

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

function recordedDates(): unknown[] {
  return db
    .prepare("SELECT occurred_on FROM expenses WHERE source_key LIKE 'rec:%' ORDER BY occurred_on")
    .pluck()
    .all();
}

// `500 кино` on Saturday 17 October, repeated weekly on Tuesday 20 October.
function saturdayRule(): RuleId {
  const expenseId = record(alice, '500 кино', new Date('2026-10-17T10:00:00Z'), 'tg:1001:2');
  const made = createRuleFromExpense(deps, {
    user: alice,
    expenseId,
    choice: 'w',
    now: new Date('2026-10-20T10:00:00Z'),
  });
  if (made.kind !== 'created') throw new Error('rule not made');
  return made.rule.id;
}

describe('weekly and yearly rules', () => {
  it('a weekly rule and a yearly rule are due on the expense weekday and day', () => {
    const expenseId = record(alice, '500 кино', new Date('2026-10-17T10:00:00Z'), 'tg:1001:2');
    const now = new Date('2026-10-20T10:00:00Z');
    const weekly = createRuleFromExpense(deps, { user: alice, expenseId, choice: 'w', now });
    const yearly = createRuleFromExpense(deps, { user: alice, expenseId, choice: 'y', now });

    expect(weekly).toMatchObject({
      rule: { schedule: { kind: 'weekly', weekday: 6 }, nextDueOn: '2026-10-24' },
    });
    expect(yearly).toMatchObject({
      rule: { schedule: { kind: 'yearly', day: 17, month: 10 }, nextDueOn: '2027-10-17' },
    });
  });
});

describe('DST, catch-up and a timezone change', () => {
  it('a Saturday rule fires at 07:00Z on 24 October (CEST) and 08:00Z on 31 October (CET)', () => {
    saturdayRule();

    tick('2026-10-24T06:59:00Z');
    expect(recordedDates()).toEqual([]);
    tick('2026-10-24T07:00:00Z');
    expect(recordedDates()).toEqual(['2026-10-24']);
    tick('2026-10-31T07:59:00Z');
    expect(recordedDates()).toEqual(['2026-10-24']);
    tick('2026-10-31T08:00:00Z');
    expect(recordedDates()).toEqual(['2026-10-24', '2026-10-31']);
  });

  it('after downtime from 31 October to 2 December, records 1 November and 1 December once each', () => {
    const id = rentRule();

    tick('2026-12-02T10:00:00Z');
    tick('2026-12-02T10:01:00Z');

    expect(recordedDates()).toEqual(['2026-11-01', '2026-12-01']);
    expect(findRule(db, id)?.nextDueOn).toBe('2027-01-01');
  });

  it('records at most 31 missed occurrences a tick; the rest follow on the next', () => {
    const id = saturdayRule();

    tick('2027-08-01T10:00:00Z');
    expect(recordedDates()).toHaveLength(31);
    expect(findRule(db, id)?.nextDueOn).toBe('2027-05-29');

    tick('2027-08-01T10:01:00Z');
    expect(recordedDates()).toHaveLength(41);
    expect(findRule(db, id)?.nextDueOn).toBe('2027-08-07');
  });

  it('a user who moved from Belgrade to Asia/Almaty gets the next occurrence at 04:00Z', () => {
    rentRule();
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Asia/Almaty', alice.id);

    tick('2026-11-01T03:59:00Z');
    expect(recordedDates()).toEqual([]);
    tick('2026-11-01T04:00:00Z');
    expect(recordedDates()).toEqual(['2026-11-01']);
  });
});

describe('a sealed ledger (ADR-0035)', () => {
  function personalLedgerId(): LedgerId {
    const ledger = findPersonalLedger(db, alice.id);
    if (ledger === undefined) throw new Error('setup: no personal ledger');
    return ledger.id;
  }

  function ruleRow(id: RuleId): unknown {
    return db
      .prepare(
        `SELECT amount_minor, currency, description, category_id, sealed IS NOT NULL AS sealed
           FROM recurring_rules WHERE id = ?`,
      )
      .get(id);
  }

  function occurrence(id: RuleId, dueOn: string): StoredExpense {
    const stored = findExpenseBySourceKey(db, `rec:${id}:${dueOn}`);
    if (stored === undefined) throw new Error('no occurrence');
    return stored;
  }

  // Encryption on, unlocked, `45000 аренда` recorded and repeated monthly, then locked.
  async function sealedRentRule(): Promise<RuleId> {
    await sealPersonalLedger(deps, alice, CREATED);
    await unlockPersonalLedger(deps, alice, CREATED);
    const id = rentRule();
    deps.keys.lock(personalLedgerId());
    return id;
  }

  const SEALED_TEMPLATE = {
    amount_minor: null,
    currency: 'RSD',
    description: null,
    category_id: null,
    sealed: 1,
  };

  it('a rule made in a sealed ledger holds no plaintext amount or description', async () => {
    const id = await sealedRentRule();

    expect(ruleRow(id)).toEqual(SEALED_TEMPLATE);
  });

  it('an occurrence fired while locked opens after /unlock to the template, on the due date', async () => {
    const id = await sealedRentRule();

    tick('2026-11-01T08:00:00Z');

    const stored = occurrence(id, '2026-11-01');
    expect(stored).toMatchObject({ sealedRuleId: id, occurredOn: '2026-11-01' });
    expect(openExpense(deps, stored)).toEqual(LOCKED);
    await unlockPersonalLedger(deps, alice, CREATED);
    expect(openExpense(deps, stored)).toMatchObject({
      amountMinor: 4500000,
      currency: 'RSD',
      description: 'аренда',
      occurredOn: '2026-11-01',
      category: { name: 'Жильё и коммуналка' },
    });
  });

  it('an edited occurrence still opens, sealed under its own id', async () => {
    const id = await sealedRentRule();
    tick('2026-11-01T08:00:00Z');
    await unlockPersonalLedger(deps, alice, CREATED);
    const expenseId = occurrence(id, '2026-11-01').id;

    startEdit(deps, { user: alice, expenseId, kind: 'editAmount', now: CREATED });
    const edited = answerEditFlow(deps, {
      user: alice,
      flow: { kind: 'editAmount', expenseId },
      text: '47000',
      inputKey: 'tg:1001:90',
      now: CREATED,
    });

    expect(edited).toMatchObject({ kind: 'editable', changed: true });
    const stored = occurrence(id, '2026-11-01');
    expect(stored).toMatchObject({ sealedRuleId: null });
    expect(openExpense(deps, stored)).toMatchObject({
      amountMinor: 4700000,
      description: 'аренда',
    });
  });

  it("the rule's template copied onto a row that names no rule fails to open", async () => {
    const id = await sealedRentRule();
    tick('2026-11-01T08:00:00Z');
    await unlockPersonalLedger(deps, alice, CREATED);
    db.prepare('UPDATE expenses SET sealed_rule_id = NULL WHERE source_key = ?').run(
      `rec:${id}:2026-11-01`,
    );

    expect(() => openExpense(deps, occurrence(id, '2026-11-01'))).toThrow();
  });

  it('enabling encryption seals an existing rule, and its next occurrence opens', async () => {
    const id = rentRule();

    await sealPersonalLedger(deps, alice, CREATED);

    expect(ruleRow(id)).toEqual(SEALED_TEMPLATE);
    tick('2026-11-01T08:00:00Z');
    expect(occurrence(id, '2026-11-01')).toMatchObject({ sealedRuleId: id });
    await unlockPersonalLedger(deps, alice, CREATED);
    expect(openExpense(deps, occurrence(id, '2026-11-01'))).toMatchObject({
      amountMinor: 4500000,
      description: 'аренда',
      occurredOn: '2026-11-01',
    });
  });

  it('an ask occurrence records the sealed template, and takes no other amount', async () => {
    const id = await sealedRentRule();
    db.prepare("UPDATE recurring_rules SET mode = 'ask'").run();
    tick('2026-11-01T08:00:00Z');
    const dueOn = '2026-11-01' as LocalDate;
    const answer = (amountMinor?: number) =>
      answerAsk(deps, {
        user: alice,
        ruleId: id,
        dueOn,
        now: CREATED,
        answer: amountMinor === undefined ? { kind: 'record' } : { kind: 'record', amountMinor },
      });

    expect(answer(487000)).toEqual({ kind: 'sealed' });
    expect(answer()).toMatchObject({ kind: 'recorded' });
    expect(occurrence(id, '2026-11-01')).toMatchObject({ sealedRuleId: id });
    await unlockPersonalLedger(deps, alice, CREATED);
    expect(openExpense(deps, occurrence(id, '2026-11-01'))).toMatchObject({
      amountMinor: 4500000,
    });
  });
});
