import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import type { ExpenseId } from '../db/expenses.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { answerEditFlow, openEdit, setDateFromButton, startEdit } from './editExpense.js';
import { routeText, type EditFlow } from './flowSessions.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, undoExpense, type RecordDeps } from './recordExpense.js';

// Wednesday 30 September, 12:00 local (CEST).
const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps;
let logLines: string[];
let alice: User;
let bob: User;
let expenseId: ExpenseId;
let inputs: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
  };
  const provision = (externalId: string) =>
    provisionUser(deps, {
      provider: 'telegram',
      externalId,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    }).user;
  alice = provision('1001');
  bob = provision('1002');
  const recorded = recordExpense(deps, {
    user: alice,
    text: '450 кофе',
    sourceKey: 'tg:1001:10',
    occurredAt: NOW,
    now: NOW,
  });
  if (recorded.kind !== 'recorded') throw new Error('setup failed');
  expenseId = recorded.expense.id;
  inputs = 10;
});

function row(): unknown {
  return db
    .prepare(
      `SELECT amount_minor, currency, description, description_key, category_id, occurred_at,
              occurred_on, updated_at FROM expenses`,
    )
    .get();
}

const ORIGINAL = {
  amount_minor: 45000,
  currency: 'RSD',
  description: 'кофе',
  description_key: 'кофе',
  occurred_at: '2026-09-30T10:00:00.000Z',
  occurred_on: '2026-09-30',
  updated_at: null,
};

function answer(kind: EditFlow['kind'], text: string, inputKey = `tg:1001:${++inputs}`) {
  startEdit(deps, { user: alice, expenseId, kind, now: NOW });
  return answerEditFlow(deps, {
    user: alice,
    flow: { kind, expenseId },
    text,
    inputKey,
    now: NOW,
  });
}

function pending(): unknown {
  return routeText(deps, { user: alice, inputKey: 'tg:1001:999', now: NOW }).kind;
}

describe('answerEditFlow: amount', () => {
  it('sets 1 200 as 120000 in the expense currency and stamps updated_at', () => {
    expect(answer('editAmount', '1 200')).toMatchObject({
      kind: 'editable',
      changed: true,
      expense: { amountMinor: 120000, currency: 'RSD' },
    });
    expect(row()).toMatchObject({
      ...ORIGINAL,
      amount_minor: 120000,
      updated_at: '2026-09-30T10:00:00.000Z',
    });
    expect(pending()).toBe('free');
  });

  it('sets 12,5 EUR as 1250 EUR', () => {
    answer('editAmount', '12,5 EUR');
    expect(row()).toMatchObject({ amount_minor: 1250, currency: 'EUR' });
  });

  it('re-asks 1.200 with both readings, changes nothing, keeps the flow', () => {
    expect(answer('editAmount', '1.200')).toMatchObject({
      kind: 'invalid',
      reason: 'ambiguousAmount',
      currency: 'RSD',
      readings: [
        { interpretation: 'thousands', amountMinor: 120000 },
        { interpretation: 'decimal', amountMinor: 120 },
      ],
    });
    expect(row()).toEqual(expect.objectContaining(ORIGINAL));
    expect(pending()).toBe('flow');
  });

  it.each([
    ['abc', 'invalidAmount'],
    ['450 кофе', 'expenseShaped'],
  ])('re-asks %j as %s and changes nothing', (text, reason) => {
    expect(answer('editAmount', text)).toMatchObject({ kind: 'invalid', reason });
    expect(row()).toEqual(expect.objectContaining(ORIGINAL));
    expect(pending()).toBe('flow');
  });

  it('writes nothing for the same amount but completes the flow', () => {
    expect(answer('editAmount', '450')).toMatchObject({ kind: 'editable', changed: false });
    expect(row()).toEqual(expect.objectContaining(ORIGINAL));
    expect(pending()).toBe('free');
  });
});

describe('answerEditFlow: description', () => {
  it('sets капучино with its description key and keeps the category', () => {
    const before = db.prepare('SELECT category_id FROM expenses').pluck().get();

    answer('editDescription', 'капучино');

    expect(row()).toMatchObject({
      description: 'капучино',
      description_key: 'капучино',
      category_id: before,
    });
  });

  it.each([
    ['   ', 'empty'],
    ['450 кофе', 'expenseShaped'],
  ])('re-asks %j as %s and changes nothing', (text, reason) => {
    expect(answer('editDescription', text)).toMatchObject({ kind: 'invalid', reason });
    expect(row()).toEqual(expect.objectContaining(ORIGINAL));
  });
});

describe('answerEditFlow: date', () => {
  it('sets a typed 25.09 by the free-text rule and keeps occurred_at', () => {
    answer('editDate', '25.09');
    expect(row()).toMatchObject({
      occurred_on: '2026-09-25',
      occurred_at: '2026-09-30T10:00:00.000Z',
    });
  });

  it.each([
    ['05.10.2026', 'futureDate'],
    ['завтра', 'invalidDate'],
  ])('re-asks %j as %s', (text, reason) => {
    expect(answer('editDate', text)).toMatchObject({ kind: 'invalid', reason });
    expect(row()).toEqual(expect.objectContaining(ORIGINAL));
  });
});

describe('answerEditFlow: refusals and idempotency', () => {
  it('clears the flow and writes nothing once the expense was undone mid-flow', () => {
    startEdit(deps, { user: alice, expenseId, kind: 'editAmount', now: NOW });
    undoExpense(deps, { user: alice, expenseId, now: NOW });

    const result = answerEditFlow(deps, {
      user: alice,
      flow: { kind: 'editAmount', expenseId },
      text: '1 200',
      inputKey: 'tg:1001:50',
      now: NOW,
    });

    expect(result).toMatchObject({ kind: 'gone', expense: { id: expenseId } });
    expect(row()).toMatchObject({ amount_minor: 45000, updated_at: null });
    expect(pending()).toBe('free');
  });

  it('routes a redelivered answer as redelivered after it applied', () => {
    answer('editAmount', '1 200', 'tg:1001:77');

    expect(routeText(deps, { user: alice, inputKey: 'tg:1001:77', now: NOW })).toEqual({
      kind: 'redelivered',
    });
  });

  it('logs no amount or description at info', () => {
    answer('editAmount', '1 200');
    answer('editDescription', 'капучино');

    expect(logLines.filter((line) => line.includes('expense edited'))).toHaveLength(2);
    for (const line of logLines) {
      const fields = Object.entries(JSON.parse(line) as Record<string, unknown>).filter(
        ([key]) => !['time', 'pid', 'hostname'].includes(key),
      );
      const content = JSON.stringify(Object.fromEntries(fields));
      for (const secret of ['450', '1200', '120000', '45000', 'кофе', 'капучино']) {
        expect(content).not.toContain(secret);
      }
    }
  });
});

describe('openEdit and setDateFromButton', () => {
  it('refuses a non-author and a deleted expense', () => {
    expect(openEdit(deps, { user: bob, expenseId })).toEqual({ kind: 'forbidden' });
    undoExpense(deps, { user: alice, expenseId, now: NOW });
    expect(openEdit(deps, { user: alice, expenseId })).toEqual({ kind: 'deleted' });
    expect(
      setDateFromButton(deps, { user: alice, expenseId, date: '2026-09-29', now: NOW }),
    ).toEqual({ kind: 'deleted' });
  });

  it('sets the button date once; the same date again writes nothing', () => {
    expect(
      setDateFromButton(deps, { user: alice, expenseId, date: '2026-09-29', now: NOW }),
    ).toMatchObject({ kind: 'editable', changed: true, expense: { occurredOn: '2026-09-29' } });
    const stamped = row();
    expect(stamped).toMatchObject({ occurred_on: '2026-09-29' });

    const later = new Date('2026-09-30T11:00:00Z');
    expect(
      setDateFromButton(deps, { user: alice, expenseId, date: '2026-09-29', now: later }),
    ).toMatchObject({ kind: 'editable', changed: false });
    expect(row()).toEqual(stamped);
  });

  it('keeps an absolute date past local midnight', () => {
    // 01:30 on 1 October in Belgrade.
    const afterMidnight = new Date('2026-09-30T23:30:00Z');
    setDateFromButton(deps, { user: alice, expenseId, date: '2026-09-29', now: afterMidnight });
    expect(row()).toMatchObject({ occurred_on: '2026-09-29' });
  });

  it.each(['2026-10-05', '2026-02-30'])('refuses %s and writes nothing', (date) => {
    expect(setDateFromButton(deps, { user: alice, expenseId, date, now: NOW })).toEqual({
      kind: 'unavailable',
    });
    expect(row()).toEqual(expect.objectContaining(ORIGINAL));
  });
});
