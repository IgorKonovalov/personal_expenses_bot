import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import type { ExpenseId } from '../db/expenses.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, restoreExpense, undoExpense, type RecordDeps } from './recordExpense.js';

// Message sent 23:50 local (CEST) on the 29th, processed 00:10 local on the 30th.
const SENT = new Date('2026-09-29T21:50:00Z');
const PROCESSED = new Date('2026-09-29T22:10:00Z');

let db: Db;
let deps: RecordDeps;
let logLines: string[];
let alice: User;
let bob: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, PROCESSED);
  let n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
  };
  const provision = (externalId: string) =>
    provisionUser(deps, {
      provider: 'telegram',
      externalId,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: PROCESSED,
    }).user;
  alice = provision('1001');
  bob = provision('1002');
});

function record(user: User, text: string, sourceKey = 'tg:1001:10') {
  return recordExpense(deps, { user, text, sourceKey, occurredAt: SENT, now: PROCESSED });
}

function expenseRows(): unknown[] {
  return db
    .prepare(
      'SELECT amount_minor, currency, description, occurred_at, occurred_on, source_key, deleted_at FROM expenses',
    )
    .all();
}

describe('recordExpense', () => {
  it('stores 450 coffee as 45000 RSD in the personal ledger, dated by the message', () => {
    const result = record(alice, '450 coffee');

    expect(result.kind).toBe('recorded');
    if (result.kind !== 'recorded') return;
    expect(result.duplicate).toBe(false);
    expect(result.ledger).toMatchObject({ kind: 'personal', name: 'Personal' });
    expect(expenseRows()).toEqual([
      {
        amount_minor: 45000,
        currency: 'RSD',
        description: 'coffee',
        occurred_at: '2026-09-29T21:50:00.000Z',
        occurred_on: '2026-09-29',
        source_key: 'tg:1001:10',
        deleted_at: null,
      },
    ]);
  });

  it('records a redelivered message once and returns the existing expense', () => {
    const first = record(alice, '450 coffee');
    const second = record(alice, '450 coffee');

    expect(expenseRows()).toHaveLength(1);
    expect(first.kind === 'recorded' && first.duplicate).toBe(false);
    expect(second.kind === 'recorded' && second.duplicate).toBe(true);
    if (first.kind !== 'recorded' || second.kind !== 'recorded') return;
    expect(second.expense).toEqual(first.expense);
  });

  it('records nothing for an ambiguous amount and returns both readings', () => {
    expect(record(alice, '1.200 lunch')).toMatchObject({
      kind: 'ambiguous',
      readings: [
        { interpretation: 'thousands', amountMinor: 120000 },
        { interpretation: 'decimal', amountMinor: 120 },
      ],
      currency: 'RSD',
      description: 'lunch',
    });
    expect(expenseRows()).toEqual([]);
  });

  it('records nothing for non-expense text', () => {
    expect(record(alice, 'coffee 450')).toEqual({ kind: 'notExpense' });
    expect(expenseRows()).toEqual([]);
  });

  it('logs no amount or description at info', () => {
    record(alice, '450 coffee');

    const recorded = logLines.filter((line) => line.includes('expense recorded'));
    expect(recorded).toHaveLength(1);
    for (const line of logLines) {
      // time, pid and hostname can contain any digits; they are not expense content.
      const fields = Object.entries(JSON.parse(line) as Record<string, unknown>).filter(
        ([key]) => !['time', 'pid', 'hostname'].includes(key),
      );
      const content = JSON.stringify(Object.fromEntries(fields));
      expect(content).not.toContain('450');
      expect(content).not.toContain('coffee');
    }
  });
});

describe('undoExpense', () => {
  function recordedId(): ExpenseId {
    const result = record(alice, '450 coffee');
    if (result.kind !== 'recorded') throw new Error('setup failed');
    return result.expense.id;
  }

  function deletedAt(): unknown {
    return db.prepare('SELECT deleted_at FROM expenses').pluck().get();
  }

  it('sets deleted_at once; a second tap reports already undone and changes nothing', () => {
    const expenseId = recordedId();
    const firstTap = new Date('2026-09-29T22:11:00Z');
    const secondTap = new Date('2026-09-29T22:12:00Z');

    expect(undoExpense(deps, { user: alice, expenseId, now: firstTap }).kind).toBe('undone');
    expect(deletedAt()).toBe('2026-09-29T22:11:00.000Z');

    expect(undoExpense(deps, { user: alice, expenseId, now: secondTap })).toEqual({
      kind: 'alreadyUndone',
    });
    expect(deletedAt()).toBe('2026-09-29T22:11:00.000Z');
  });

  it("refuses a tap from a user who isn't the creator", () => {
    const expenseId = recordedId();

    expect(undoExpense(deps, { user: bob, expenseId, now: PROCESSED })).toEqual({
      kind: 'forbidden',
    });
    expect(deletedAt()).toBeNull();
  });
});

describe('restoreExpense', () => {
  function deletedId(): ExpenseId {
    const result = record(alice, '450 coffee');
    if (result.kind !== 'recorded') throw new Error('setup failed');
    undoExpense(deps, { user: alice, expenseId: result.expense.id, now: PROCESSED });
    return result.expense.id;
  }

  function deletedAt(): unknown {
    return db.prepare('SELECT deleted_at FROM expenses').pluck().get();
  }

  it('clears deleted_at once; a second restore reports already restored', () => {
    const expenseId = deletedId();

    const restored = restoreExpense(deps, { user: alice, expenseId });
    expect(restored).toMatchObject({
      kind: 'restored',
      expense: { id: expenseId, amountMinor: 45000, currency: 'RSD', deletedAt: null },
      ledger: { kind: 'personal' },
    });
    expect(deletedAt()).toBeNull();

    expect(restoreExpense(deps, { user: alice, expenseId })).toEqual({ kind: 'alreadyRestored' });
    expect(deletedAt()).toBeNull();
  });

  it('reports a never-deleted expense as already restored and writes nothing', () => {
    const result = record(alice, '450 coffee');
    if (result.kind !== 'recorded') throw new Error('setup failed');

    expect(restoreExpense(deps, { user: alice, expenseId: result.expense.id })).toEqual({
      kind: 'alreadyRestored',
    });
    expect(deletedAt()).toBeNull();
  });

  it("refuses a user who isn't the creator and leaves the expense deleted", () => {
    const expenseId = deletedId();

    expect(restoreExpense(deps, { user: bob, expenseId })).toEqual({ kind: 'forbidden' });
    expect(deletedAt()).toBe('2026-09-29T22:10:00.000Z');
  });

  it('logs no amount or description at info', () => {
    const expenseId = deletedId();
    logLines.length = 0;

    restoreExpense(deps, { user: alice, expenseId });

    expect(logLines.filter((line) => line.includes('expense restored'))).toHaveLength(1);
    for (const line of logLines) {
      const fields = Object.entries(JSON.parse(line) as Record<string, unknown>).filter(
        ([key]) => !['time', 'pid', 'hostname'].includes(key),
      );
      const content = JSON.stringify(Object.fromEntries(fields));
      expect(content).not.toContain('coffee');
      expect(content).not.toContain('450');
    }
  });

  it('reports an unknown expense as not found', () => {
    expect(
      restoreExpense(deps, {
        user: alice,
        expenseId: '00000000-0000-4000-8000-999999999999' as ExpenseId,
      }),
    ).toEqual({ kind: 'notFound' });
    expect(
      undoExpense(deps, {
        user: alice,
        expenseId: '00000000-0000-4000-8000-999999999999' as ExpenseId,
        now: PROCESSED,
      }),
    ).toEqual({ kind: 'notFound' });
  });
});
