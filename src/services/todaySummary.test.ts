import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, undoExpense, type RecordDeps } from './recordExpense.js';
import { recentDayTotals, todaySummary } from './todaySummary.js';

// 12:00 local (CEST) on 2026-09-30.
const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let messageId: number;

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
  user = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
  messageId = 0;
});

function record(text: string, sentAt: string) {
  const result = recordExpense(deps, {
    user,
    text,
    sourceKey: `tg:1001:${++messageId}`,
    occurredAt: new Date(sentAt),
    now: NOW,
  });
  if (result.kind !== 'recorded') throw new Error(`setup: ${text} was ${result.kind}`);
  return result.expense;
}

// A plaintext ledger never reads as locked.
function today() {
  const summary = todaySummary(deps, { user, now: NOW });
  if ('kind' in summary) throw new Error('a plaintext ledger read as locked');
  return summary;
}

describe('todaySummary', () => {
  it("sums the user's local today per currency, excluding yesterday and undone", () => {
    record('450 coffee', '2026-09-29T22:30:00Z'); // 00:30 local on the 30th
    record('12.50 bread', '2026-09-30T08:00:00Z');
    record('12.50 EUR taxi', '2026-09-30T09:00:00Z');
    record('100 late snack', '2026-09-29T21:30:00Z'); // 23:30 local on the 29th
    const undone = record('50 mistake', '2026-09-30T09:30:00Z');
    expect(undoExpense(deps, { user, expenseId: undone.id, now: NOW }).kind).toBe('undone');

    const summary = today();

    expect(summary.date).toBe('2026-09-30');
    expect(Object.fromEntries(summary.totals)).toEqual({ RSD: 46250, EUR: 1250 });
    expect(summary.ledger).toMatchObject({ kind: 'personal' });
  });

  it('is empty on a day with nothing recorded', () => {
    record('100 late snack', '2026-09-29T21:30:00Z');

    expect(today().totals.size).toBe(0);
  });
});

describe('recentDayTotals', () => {
  it("counts an expense at 00:30 local on the 12th in the 12th's total, the last of seven days", () => {
    const at = new Date('2026-11-12T10:00:00Z');
    record('450 кофе', '2026-11-11T23:30:00Z');
    record('120 хлеб', '2026-11-11T12:00:00Z');
    record('80 чай', '2026-11-06T09:00:00Z');
    record('999 давно', '2026-11-05T09:00:00Z');

    const recent = recentDayTotals(deps, { user, now: at });

    if ('kind' in recent) throw new Error('a plaintext ledger read as locked');
    expect(recent.date).toBe('2026-11-12');
    expect(recent.days).toEqual([
      { date: '2026-11-06', totalMinor: 8000 },
      { date: '2026-11-07', totalMinor: 0 },
      { date: '2026-11-08', totalMinor: 0 },
      { date: '2026-11-09', totalMinor: 0 },
      { date: '2026-11-10', totalMinor: 0 },
      { date: '2026-11-11', totalMinor: 12000 },
      { date: '2026-11-12', totalMinor: 45000 },
    ]);
    expect(recent.approximate).toBe(false);
  });

  it('ends at the given date, whatever the clock says', () => {
    record('450 кофе', '2026-11-11T23:30:00Z');

    const recent = recentDayTotals(deps, {
      user,
      date: '2026-11-12' as LocalDate,
      now: new Date('2026-11-13T08:00:00Z'),
    });

    if ('kind' in recent) throw new Error('a plaintext ledger read as locked');
    expect(recent.days.at(-1)).toEqual({ date: '2026-11-12', totalMinor: 45000 });
  });
});
