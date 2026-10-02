import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveCategory, type CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { findHistoryCategory, type ExpenseId } from '../db/expenses.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, restoreExpense, undoExpense, type RecordDeps } from './recordExpense.js';
import { sealPersonalLedger } from './testing/sealLedger.js';
import { seedLedgerCategories } from './seedCategories.js';

// The history step's repository call, spied on and passed through, so a test can assert it never
// runs for a sealed ledger.
vi.mock('../db/expenses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/expenses.js')>();
  return { ...actual, findHistoryCategory: vi.fn(actual.findHistoryCategory) };
});

// Message sent 23:50 local (CEST) on the 29th, processed 00:10 local on the 30th.
const SENT = new Date('2026-09-29T21:50:00Z');
const PROCESSED = new Date('2026-09-29T22:10:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
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
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => PROCESSED),
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

  it('records the chosen reading of an ambiguous amount', () => {
    const thousands = recordExpense(deps, {
      user: alice,
      text: '1.200 lunch',
      sourceKey: 'tg:1001:10',
      occurredAt: SENT,
      now: PROCESSED,
      reading: 'thousands',
    });
    const decimal = recordExpense(deps, {
      user: alice,
      text: '1.200 lunch',
      sourceKey: 'tg:1001:11',
      occurredAt: SENT,
      now: PROCESSED,
      reading: 'decimal',
    });

    expect(thousands).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(decimal).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(
      db.prepare('SELECT amount_minor, currency, description, source_key FROM expenses').all(),
    ).toEqual([
      { amount_minor: 120000, currency: 'RSD', description: 'lunch', source_key: 'tg:1001:10' },
      { amount_minor: 120, currency: 'RSD', description: 'lunch', source_key: 'tg:1001:11' },
    ]);
  });

  it('returns the stored expense for a second reading under the same source key', () => {
    const input = { user: alice, text: '1.200 lunch', sourceKey: 'tg:1001:10', occurredAt: SENT };
    recordExpense(deps, { ...input, now: PROCESSED, reading: 'thousands' });

    const again = recordExpense(deps, { ...input, now: PROCESSED, reading: 'decimal' });

    expect(again).toMatchObject({
      kind: 'recorded',
      duplicate: true,
      expense: { amountMinor: 120000 },
    });
    expect(expenseRows()).toHaveLength(1);
  });

  it('reports a reading the text no longer offers and records nothing', () => {
    const input = { user: alice, sourceKey: 'tg:1001:10', occurredAt: SENT, now: PROCESSED };

    expect(recordExpense(deps, { ...input, text: '1.234 lunch', reading: 'decimal' })).toEqual({
      kind: 'readingUnavailable',
    });
    expect(recordExpense(deps, { ...input, text: '450 lunch', reading: 'thousands' })).toEqual({
      kind: 'readingUnavailable',
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

describe('recordExpense into an explicit target ledger', () => {
  // 01:30 on the 30th in Belgrade (CEST, UTC+2), 19:30 on the 29th in New York (EDT, UTC-4).
  const LATE = new Date('2026-09-29T23:30:00Z');
  const SHARED = 'shared-ledger' as LedgerId;

  beforeEach(() => {
    insertLedger(db, {
      id: SHARED,
      kind: 'shared',
      name: 'Family',
      defaultCurrency: 'EUR',
      timezone: 'America/New_York',
      ownerUserId: alice.id,
      createdAt: PROCESSED,
    });
    insertMember(db, { ledgerId: SHARED, userId: alice.id, role: 'owner' });
    seedLedgerCategories(db, SHARED, PROCESSED);
  });

  function recordAt(
    user: User,
    sourceKey: string,
    target?: { kind: 'ledger'; ledgerId: LedgerId },
  ) {
    return recordExpense(deps, {
      user,
      text: '12 taxi',
      sourceKey,
      occurredAt: LATE,
      now: LATE,
      ...(target === undefined ? {} : { target }),
    });
  }

  function rowOf(sourceKey: string): unknown {
    return db
      .prepare(
        'SELECT ledger_id, amount_minor, currency, occurred_on FROM expenses WHERE source_key = ?',
      )
      .get(sourceKey);
  }

  it("records into the target ledger, in its currency, dated in the ledger's timezone", () => {
    const result = recordAt(alice, 'tg:-1:1', { kind: 'ledger', ledgerId: SHARED });

    expect(result).toMatchObject({ kind: 'recorded', ledger: { id: SHARED } });
    expect(rowOf('tg:-1:1')).toEqual({
      ledger_id: SHARED,
      amount_minor: 1200,
      currency: 'EUR',
      occurred_on: '2026-09-29',
    });
    expect(
      db.prepare('SELECT active_ledger_id FROM users WHERE id = ?').pluck().get(alice.id),
    ).toBe(alice.activeLedgerId);
  });

  it("without a target records into the active ledger, dated in the user's timezone", () => {
    recordAt(alice, 'tg:1001:1');

    expect(rowOf('tg:1001:1')).toEqual({
      ledger_id: alice.activeLedgerId,
      amount_minor: 1200,
      currency: 'RSD',
      occurred_on: '2026-09-30',
    });
  });

  it('refuses a target ledger the user is not a member of, writing nothing', () => {
    expect(() => recordAt(bob, 'tg:-1:2', { kind: 'ledger', ledgerId: SHARED })).toThrow(
      'not a member',
    );
    expect(rowOf('tg:-1:2')).toBeUndefined();
  });
});

describe('recordExpense with a date word (sent 2026-09-29 local)', () => {
  function stored(): unknown {
    return db
      .prepare('SELECT amount_minor, currency, description, occurred_at, occurred_on FROM expenses')
      .get();
  }

  it.each([
    ['450 такси вчера', '2026-09-28'],
    ['450 такси Позавчера', '2026-09-27'],
    ['450 такси 25.09', '2026-09-25'],
    ['450 такси 5.09', '2026-09-05'],
    ['450 такси 05.10', '2025-10-05'],
    ['450 такси 29.09', '2026-09-29'],
    ['450 такси 25.09.2025', '2025-09-25'],
  ])('%j stores 45000 RSD такси on %s and keeps occurred_at', (text, occurredOn) => {
    expect(record(alice, text).kind).toBe('recorded');
    expect(stored()).toEqual({
      amount_minor: 45000,
      currency: 'RSD',
      description: 'такси',
      occurred_at: '2026-09-29T21:50:00.000Z',
      occurred_on: occurredOn,
    });
  });

  it('stores 450 EUR такси вчера as 45000 EUR on 2026-09-28', () => {
    record(alice, '450 EUR такси вчера');
    expect(stored()).toMatchObject({
      amount_minor: 45000,
      currency: 'EUR',
      description: 'такси',
      occurred_on: '2026-09-28',
    });
  });

  it.each([
    ['450 такси 31.02', 'такси 31.02'],
    ['450 молоко 1.5', 'молоко 1.5'],
    ['450 вчера такси', 'вчера такси'],
  ])('%j stores description %j on today', (text, description) => {
    record(alice, text);
    expect(stored()).toMatchObject({ description, occurred_on: '2026-09-29' });
  });

  it('refuses a future literal date and records nothing', () => {
    expect(record(alice, '450 такси 05.10.2026')).toEqual({ kind: 'futureDate' });
    expect(expenseRows()).toEqual([]);
  });

  it.each(['450 вчера', '450 EUR вчера'])('%j is invalid and records nothing', (text) => {
    expect(record(alice, text)).toEqual({ kind: 'invalid' });
    expect(expenseRows()).toEqual([]);
  });

  it("counts back from the user's local date, not UTC", () => {
    // 22:30Z on the 29th is 00:30 on the 30th in Belgrade.
    recordExpense(deps, {
      user: alice,
      text: '450 такси вчера',
      sourceKey: 'tg:1001:10',
      occurredAt: new Date('2026-09-29T22:30:00Z'),
      now: new Date('2026-09-29T22:31:00Z'),
    });
    expect(stored()).toMatchObject({ occurred_on: '2026-09-29' });
  });

  it('suggests the category from the description without the date word', () => {
    const result = record(alice, '450 такси вчера');

    const transport = db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'transport'")
      .pluck()
      .get(alice.activeLedgerId);
    expect(db.prepare('SELECT category_id, description_key FROM expenses').get()).toEqual({
      category_id: transport,
      description_key: 'такси',
    });
    expect(result).toMatchObject({ kind: 'recorded', expense: { occurredOn: '2026-09-28' } });
  });

  it('records the chosen reading of an ambiguous amount on its date', () => {
    recordExpense(deps, {
      user: alice,
      text: '1.200 обед вчера',
      sourceKey: 'tg:1001:10',
      occurredAt: SENT,
      now: PROCESSED,
      reading: 'thousands',
    });
    expect(stored()).toMatchObject({
      amount_minor: 120000,
      description: 'обед',
      occurred_on: '2026-09-28',
    });
  });
});

describe('recordExpense picks a category', () => {
  function presetOf(text: string, sourceKey: string): unknown {
    const result = record(alice, text, sourceKey);
    if (result.kind !== 'recorded') throw new Error(`not recorded: ${result.kind}`);
    return db
      .prepare('SELECT preset_key FROM categories WHERE id = ?')
      .pluck()
      .get(result.expense.category?.id);
  }

  it.each([
    ['450 кофе', 'cafe'],
    ['450 Кофейня', 'cafe'],
    ['300 такси до дома', 'transport'],
    ['999 что-то', 'other'],
    ['450 EUR coffee', 'cafe'],
  ])('%j -> %s on a freshly seeded ledger', (text, preset) => {
    expect(presetOf(text, 'tg:1001:10')).toBe(preset);
  });

  it('stores the ledger cafe category and the description key for 450 кофе', () => {
    const result = record(alice, '450 кофе');

    const cafe = db
      .prepare("SELECT id, name FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .get(alice.activeLedgerId);
    expect(db.prepare('SELECT category_id, description_key FROM expenses').get()).toEqual({
      category_id: (cafe as { id: number }).id,
      description_key: 'кофе',
    });
    expect(result).toMatchObject({
      kind: 'recorded',
      expense: { category: cafe },
    });
  });

  it('falls through to other once cafe is archived', () => {
    const cafeId = db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(alice.activeLedgerId) as CategoryId;
    archiveCategory(db, cafeId, PROCESSED);

    expect(presetOf('450 кофе', 'tg:1001:10')).toBe('other');
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

describe('recordExpense in a sealed ledger (ADR-0020)', () => {
  it('reads description_key in a plaintext ledger, and never in a sealed one', async () => {
    const history = vi.mocked(findHistoryCategory);
    history.mockClear();
    expect(record(alice, '300 кофе', 'tg:1001:1').kind).toBe('recorded');
    expect(history).toHaveBeenCalledWith(db, alice.activeLedgerId, 'кофе');

    await sealPersonalLedger(deps, bob, PROCESSED);
    history.mockClear();
    expect(record(bob, '300 кофе', 'tg:1002:1').kind).toBe('recorded');
    expect(record(bob, '300 кофе', 'tg:1002:2').kind).toBe('recorded');

    expect(history).not.toHaveBeenCalled();
    expect(
      db
        .prepare('SELECT description_key FROM expenses WHERE ledger_id = ?')
        .pluck()
        .all(bob.activeLedgerId),
    ).toEqual([null, null]);
  });
});
