import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { EXPORT_RANGES, type ExportRange } from '../domain/export/rows.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { exportActiveLedger, type LedgerExport } from './exportLedger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';

// 00:30 on Thursday 1 October in Belgrade (CEST), still 30 September in UTC.
const NOW = new Date('2026-09-30T22:30:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
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
  const provisioned = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  });
  user = provisioned.user;
  ledgerId = provisioned.ledger.id;
});

function add(
  id: string,
  occurredOn: string,
  amountMinor: number,
  currency: CurrencyCode,
  options: { occurredAt?: string; preset?: string; description?: string } = {},
) {
  const categoryId =
    options.preset === undefined
      ? undefined
      : (db
          .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
          .pluck()
          .get(ledgerId, options.preset) as CategoryId);
  insertExpenseOrGetExisting(db, {
    id: id as ExpenseId,
    ledgerId,
    createdBy: user.id,
    amountMinor,
    currency,
    description: options.description ?? `d-${id}`,
    occurredAt: new Date(options.occurredAt ?? `${occurredOn}T10:00:00Z`),
    occurredOn: occurredOn as LocalDate,
    sourceKey: `tg:${id}`,
    createdAt: NOW,
    ...(categoryId === undefined ? {} : { categoryId }),
  });
}

function plain(value: LedgerExport | Locked): LedgerExport {
  if (isLocked(value)) throw new Error('a plaintext ledger read as locked');
  return value;
}

const run = (range: ExportRange) => plain(exportActiveLedger(deps, { user, range, now: NOW }));
const ids = (range: ExportRange) => run(range).expenses.map((e) => e.id);

describe('exportActiveLedger', () => {
  beforeEach(() => {
    add('dec', '2025-12-31', 100, 'RSD');
    add('jan', '2026-01-01', 200, 'RSD');
    add('sep1', '2026-09-01', 300, 'RSD');
    add('sep30', '2026-09-30', 45000, 'RSD', { preset: 'cafe', description: 'кофе' });
    add('oct1', '2026-10-01', 1250, 'EUR', { occurredAt: '2026-09-30T22:20:00Z' });
    add('gone', '2026-09-15', 999, 'RSD');
    softDeleteExpense(db, 'gone' as ExpenseId, NOW);
  });

  it('takes this month as 1 October alone at 00:30 local on the 1st', () => {
    expect(run('tm').key).toBe('2026-10');
    expect(ids('tm')).toEqual(['oct1']);
  });

  it('puts 30 September in last month, which is all of September', () => {
    expect(run('pm').key).toBe('2026-09');
    expect(ids('pm')).toEqual(['sep1', 'sep30']);
  });

  it('takes this year from 1 January, and all time with no bounds', () => {
    expect(run('ty').key).toBe('2026');
    expect(ids('ty')).toEqual(['jan', 'sep1', 'sep30', 'oct1']);
    expect(run('all').key).toBe('all');
    expect(ids('all')).toEqual(['dec', 'jan', 'sep1', 'sep30', 'oct1']);
  });

  it('never exports a soft-deleted expense', () => {
    for (const range of EXPORT_RANGES) expect(ids(range)).not.toContain('gone');
  });

  it('resolves the amount, currency, category name and description', () => {
    const sep30 = run('pm').expenses.find((e) => e.id === 'sep30');

    expect(sep30).toEqual({
      id: 'sep30',
      occurredOn: '2026-09-30',
      amount: { amountMinor: 45000, currency: 'RSD' },
      category: 'Кафе и рестораны',
      description: 'кофе',
    });
  });
});
