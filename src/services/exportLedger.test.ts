import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { insertReceipt, markReceiptFetched, type ReceiptId } from '../db/receipts.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { EXPORT_RANGES, type ExportRange } from '../domain/export/rows.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import {
  activeExportState,
  exportActiveLedger,
  exportGroupLedger,
  type LedgerExport,
} from './exportLedger.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

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

  it('resolves time, amount, category, description and author, with no receipt', () => {
    const sep30 = run('pm').expenses.find((e) => e.id === 'sep30');

    expect(sep30).toEqual({
      id: 'sep30',
      occurredOn: '2026-09-30',
      // 10:00Z is 12:00 in Belgrade (CEST).
      time: '12:00',
      amount: { amountMinor: 45000, currency: 'RSD' },
      converted: { amountMinor: 45000, currency: 'RSD' },
      category: 'Кафе и рестораны',
      description: 'кофе',
      tags: [],
      author: null,
      shop: null,
      receiptUrl: null,
    });
  });

  it('times 22:20Z on 30 September as 00:20 on 1 October local', () => {
    expect(run('tm').expenses[0]?.time).toBe('00:20');
  });
});

describe('converted amounts (ADR-0022)', () => {
  function storeEurRate(day: string, middleE4: number) {
    const fetchedAt = new Date(`${day}T08:00:00Z`);
    storeFxList(
      db,
      {
        listDate: day as LocalDate,
        listNumber: 1,
        rates: [{ currency: 'EUR', unit: 1, middleE4 }],
      },
      fetchedAt,
    );
    setFxDay(db, day as LocalDate, day as LocalDate, fetchedAt);
  }

  it.each([
    // 1000 × 1171234 / 10000 = 117123.4, rounding half-up to 117123.
    [1171234, 117123],
    // 117123.5 rounds up to 117124.
    [1171235, 117124],
  ])('converts 10,00 EUR at %i into %i RSD minor units', (middleE4, expected) => {
    storeEurRate('2026-09-15', middleE4);
    add('eur', '2026-09-15', 1000, 'EUR');

    expect(run('pm').expenses[0]?.converted).toEqual({ amountMinor: expected, currency: 'RSD' });
  });

  it('leaves a foreign expense on a day with no rate unconverted, an RSD one as itself', () => {
    add('eur', '2026-09-15', 1000, 'EUR');
    add('rsd', '2026-09-15', 45000, 'RSD');

    expect(run('all').expenses.map((e) => [e.id, e.converted])).toEqual([
      ['eur', undefined],
      ['rsd', { amountMinor: 45000, currency: 'RSD' }],
    ]);
  });
});

describe('a sealed personal ledger (ADR-0020)', () => {
  it('exports nothing while locked, and the plaintext rows and folded receipt once unlocked', async () => {
    add('rcpt', '2026-09-12', 82912, 'RSD', { description: 'Чек' });
    const receiptId = 'receipt-1' as ReceiptId;
    insertReceipt(db, {
      id: receiptId,
      expenseId: 'rcpt' as ExpenseId,
      country: 'RS',
      fiscalId: 'F1',
      merchantKey: 'rs:1',
      verifyUrl: 'https://suf.example/v/?vl=synthetic',
      issuedAt: NOW,
      createdAt: NOW,
    });
    db.transaction(() => {
      markReceiptFetched(db, receiptId, 'Test Market');
      insertReceiptItems(db, receiptId, [{ name: 'Сыр', quantity: '0.535', totalMinor: 52913 }]);
    })();
    await sealPersonalLedger(deps, user, NOW);

    expect(activeExportState(deps, user)).toEqual({ kind: 'locked' });
    expect(exportActiveLedger(deps, { user, range: 'all', now: NOW })).toEqual({ kind: 'locked' });

    await unlockPersonalLedger(deps, user, NOW);

    expect(activeExportState(deps, user)).toEqual({ kind: 'open', sealed: true });
    const result = run('all');
    expect(result.expenses.map((e) => [e.amount.amountMinor, e.description, e.shop])).toEqual([
      [82912, 'Чек', 'Test Market'],
    ]);
    expect(result.items).toEqual([
      {
        expenseId: 'rcpt',
        occurredOn: '2026-09-12',
        shop: 'Test Market',
        position: 1,
        name: 'Сыр',
        quantity: '0.535',
        total: { amountMinor: 52913, currency: 'RSD' },
      },
    ]);
  });

  it('reads a plaintext ledger as plain', () => {
    expect(activeExportState(deps, user)).toEqual({ kind: 'open', sealed: false });
  });
});

describe('exportGroupLedger', () => {
  it('is undefined for a chat bound to no ledger', () => {
    expect(exportGroupLedger(deps, { chatId: -1, range: 'all', now: NOW })).toBeUndefined();
  });
});

describe('receipts and their items', () => {
  it("puts the shop and link on the expense and lists the items in the expense's order", () => {
    add('plain', '2026-09-10', 100, 'RSD');
    add('rcpt', '2026-09-12', 82912, 'RSD');
    const receiptId = 'receipt-1' as ReceiptId;
    insertReceipt(db, {
      id: receiptId,
      expenseId: 'rcpt' as ExpenseId,
      country: 'RS',
      fiscalId: 'F1',
      merchantKey: 'rs:1',
      verifyUrl: 'https://suf.example/v/?vl=synthetic',
      issuedAt: NOW,
      createdAt: NOW,
    });
    db.transaction(() => {
      markReceiptFetched(db, receiptId, 'Test Market');
      insertReceiptItems(db, receiptId, [
        { name: 'Хлеб', quantity: '1', totalMinor: 9999 },
        { name: 'Сыр', quantity: '0.535', totalMinor: 52913 },
        { name: 'Вода', quantity: '2', totalMinor: 20000 },
      ]);
    })();

    const result = run('pm');

    expect(result.expenses.map((e) => [e.id, e.shop, e.receiptUrl])).toEqual([
      ['plain', null, null],
      ['rcpt', 'Test Market', 'https://suf.example/v/?vl=synthetic'],
    ]);
    expect(result.items).toEqual([
      {
        expenseId: 'rcpt',
        occurredOn: '2026-09-12',
        shop: 'Test Market',
        position: 1,
        name: 'Хлеб',
        quantity: '1',
        total: { amountMinor: 9999, currency: 'RSD' },
      },
      expect.objectContaining({ expenseId: 'rcpt', position: 2, quantity: '0.535' }),
      expect.objectContaining({ expenseId: 'rcpt', position: 3, name: 'Вода' }),
    ]);
  });
});
