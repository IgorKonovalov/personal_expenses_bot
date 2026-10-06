import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveCategories } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { listLedgerExpensesBetween, setExpenseCategory, type ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { parseRaiffeisenRs } from '../domain/statements/raiffeisenRs.js';
import { parseBankSms } from '../domain/bankSms/index.js';
import { buildKoriscenjeSms } from '../domain/bankSms/testing/buildKoriscenjeSms.js';
import {
  cardRow,
  statementLines,
  TWO_PAGE_ROWS,
  type StatementRowFixture,
} from '../domain/statements/testing/raiffeisenStatement.js';
import type { StatementPurchase } from '../domain/statements/types.js';
import { createLogger } from '../logger.js';
import type { LocalDate } from '../domain/time.js';
import { createLedgerKeyring, openExpenses, type LedgerKeyring } from './ledgerKeys.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';
import { pendingStatementPreview, previewStatement, recordStatement } from './importStatement.js';
import { provisionUser } from './provisionUser.js';
import { recordBankSms } from './recordBankSms.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';

const NOW = new Date('2026-10-02T09:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let logLines: string[];
let alice: User;

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
    keys: createLedgerKeyring(() => NOW),
  };
  alice = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
});

function purchasesOf(rows: readonly StatementRowFixture[]): readonly StatementPurchase[] {
  const parsed = parseRaiffeisenRs(statementLines(rows, { rowsPerPage: 6 }));
  if (parsed.kind !== 'statement') throw new Error('synthetic statement did not parse');
  return parsed.purchases;
}

function preview(rows: readonly StatementRowFixture[] = TWO_PAGE_ROWS, now = NOW) {
  const parsed = parseRaiffeisenRs(statementLines(rows, { rowsPerPage: 6 }));
  if (parsed.kind !== 'statement') throw new Error('synthetic statement did not parse');
  const result = previewStatement(deps, { user: alice, ...parsed, now });
  if (result.kind !== 'preview') throw new Error(`expected a preview, got ${result.kind}`);
  return result;
}

function stored() {
  return db
    .prepare(
      'SELECT amount_minor, currency, occurred_on, occurred_at, description FROM expenses ORDER BY rowid',
    )
    .all();
}

// Records typed text, sent at noon UTC of `day`.
function typed(text: string, day: string) {
  const at = new Date(`${day}T12:00:00Z`);
  const result = recordExpense(deps, {
    user: alice,
    text,
    sourceKey: `tg:${alice.id}:${text}:${day}`,
    occurredAt: at,
    now: at,
  });
  if (result.kind !== 'recorded') throw new Error(`expected a record, got ${result.kind}`);
}

const USD_ROW: StatementRowFixture = {
  date: '07.09.2026',
  card: '0000',
  description: ['EXAMPLE.COM'],
  original: '15.00 USD',
  rate: '117.1234',
  debit: '1,756.85',
};

describe('matching recorded expenses (ADR-0032)', () => {
  it('matches a hand-recorded 1 250 кофе of the 12th to a row of the 13th, not of the 14th', () => {
    typed('1 250 кофе', '2026-09-12');

    const near = preview([cardRow('13.09.2026', '1,250.00', 'KAFE PRIMER')]);
    expect([near.fresh.length, near.matched.length]).toEqual([0, 1]);

    const far = preview([cardRow('14.09.2026', '1,250.00', 'KAFE PRIMER')]);
    expect([far.fresh.length, far.matched.length]).toEqual([1, 0]);
  });

  it('gives two 450.00 rows of one day against one recorded 450 one match and one new row', () => {
    typed('450 кофе', '2026-09-12');

    const result = preview([
      cardRow('12.09.2026', '450.00', 'KAFE PRIMER'),
      cardRow('12.09.2026', '450.00', 'KAFE PRIMER'),
    ]);

    expect(result.matched.map((p) => p.ordinal)).toEqual([0]);
    expect(result.fresh.map((p) => p.ordinal)).toEqual([1]);
  });

  it('matches an SMS-recorded 15.00 USD on the original amount, not on the RSD debit', () => {
    const sms = parseBankSms(
      buildKoriscenjeSms({ datum: '07.09.2026 13:00:00', iznos: '15,00 USD' }),
    );
    if (sms.kind !== 'purchase') throw new Error('synthetic SMS did not parse');
    recordBankSms(deps, {
      user: alice,
      sms,
      messageKey: 'tg:1:1',
      occurredAt: new Date('2026-09-07T12:00:00Z'),
      now: NOW,
    });

    // A row of the USD purchase's RSD debit alone, then the USD purchase.
    const result = preview([cardRow('07.09.2026', '1,756.85', 'EXAMPLE.COM'), USD_ROW]);

    expect(result.matched.map((p) => [p.amountMinor, p.currency])).toEqual([[1500, 'USD']]);
    expect(result.fresh.map((p) => [p.amountMinor, p.currency])).toEqual([[175685, 'RSD']]);
  });

  it('[Записать все] skips matched rows, and with them records the matched rows too', () => {
    typed('450 кофе', '2026-09-02');
    preview();

    expect(recordStatement(deps, { user: alice, now: NOW })).toMatchObject({ count: 5 });

    preview();
    expect(recordStatement(deps, { user: alice, now: NOW, withMatched: true })).toMatchObject({
      count: 1,
    });
    expect(stored()).toHaveLength(1 + 6);
  });

  it('counts a re-sent statement as imported: nothing new, nothing matched', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    const again = preview();

    expect([again.fresh.length, again.matched.length, again.imported.length]).toEqual([0, 0, 6]);
    expect(recordStatement(deps, { user: alice, now: NOW, withMatched: true })).toMatchObject({
      count: 0,
    });
    expect(stored()).toHaveLength(6);
  });
});

describe('limits and categories', () => {
  it('refuses more than 1000 purchases and holds nothing', () => {
    const one = purchasesOf([cardRow('02.09.2026', '1.00', 'PRIMER')])[0];
    if (one === undefined) throw new Error('setup');
    const purchases = Array.from({ length: 1001 }, (_, ordinal) => ({ ...one, ordinal }));

    expect(previewStatement(deps, { user: alice, period: undefined, purchases, now: NOW })).toEqual(
      { kind: 'tooLong' },
    );
    expect(pendingStatementPreview(deps, { user: alice, now: NOW })).toEqual({ kind: 'expired' });
    expect(
      previewStatement(deps, {
        user: alice,
        period: undefined,
        purchases: purchases.slice(0, 1000),
        now: NOW,
      }),
    ).toMatchObject({ kind: 'preview' });
  });

  it('records a merchant previously re-categorised to Продукты under Продукты', () => {
    preview([cardRow('02.09.2026', '300.00', 'KAFE PRIMER')]);
    recordStatement(deps, { user: alice, now: NOW });
    const ledgerId = db.prepare('SELECT ledger_id FROM expenses').pluck().get() as LedgerId;
    const groceries = listActiveCategories(db, ledgerId).find((c) => c.name === 'Продукты');
    if (groceries === undefined) throw new Error('setup: no Продукты');
    const firstId = db.prepare('SELECT id FROM expenses').pluck().get() as ExpenseId;
    expect(setExpenseCategory(db, firstId, groceries.id, NOW)).toBe(true);

    preview([cardRow('20.09.2026', '450.00', 'KAFE PRIMER')]);
    recordStatement(deps, { user: alice, now: NOW });

    expect(
      db
        .prepare(
          `SELECT c.name FROM expenses e JOIN categories c ON c.id = e.category_id
            WHERE e.occurred_on = '2026-09-20'`,
        )
        .pluck()
        .all(),
    ).toEqual(['Продукты']);
  });

  it('shows the pending preview again for a page tap, and nothing once expired', () => {
    const first = preview();

    expect(pendingStatementPreview(deps, { user: alice, now: NOW })).toEqual(first);
    expect(
      pendingStatementPreview(deps, { user: alice, now: new Date(NOW.getTime() + 11 * 60_000) }),
    ).toEqual({ kind: 'expired' });
  });
});

describe('sealed ledgers (Plan 0019)', () => {
  it('refuses a statement while the sealed ledger is locked and holds nothing', async () => {
    await sealPersonalLedger(deps, alice, NOW);
    const parsed = parseRaiffeisenRs(statementLines(TWO_PAGE_ROWS, { rowsPerPage: 6 }));
    if (parsed.kind !== 'statement') throw new Error('setup');

    expect(previewStatement(deps, { user: alice, ...parsed, now: NOW })).toEqual({
      kind: 'locked',
    });
    expect(db.prepare('SELECT kind FROM flow_sessions').pluck().all()).not.toContain(
      'statementImport',
    );
    expect(stored()).toEqual([]);
  });

  it('records sealed rows with content-free keys once unlocked, and they open to the amounts', async () => {
    const ledger = await sealPersonalLedger(deps, alice, NOW);
    await unlockPersonalLedger(deps, alice, NOW);
    const purchases = purchasesOf(TWO_PAGE_ROWS);
    preview();

    expect(recordStatement(deps, { user: alice, now: NOW })).toMatchObject({ count: 6 });

    expect(
      db
        .prepare('SELECT amount_minor, description, sealed IS NOT NULL AS sealed FROM expenses')
        .all(),
    ).toEqual(purchases.map(() => ({ amount_minor: null, description: null, sealed: 1 })));
    for (const key of db.prepare('SELECT source_key FROM expenses').pluck().all()) {
      expect(key).toMatch(/^sealed:[0-9a-f-]{36}$/);
    }
    const opened = openExpenses(
      deps,
      ledger.id,
      listLedgerExpensesBetween(db, {
        ledgerId: ledger.id,
        memberId: alice.id,
        from: '2026-09-01' as LocalDate,
        to: '2026-09-30' as LocalDate,
      }),
    );
    if (opened.kind !== 'open') throw new Error('expected the ledger open');
    expect(
      opened.expenses.map((e) => [e.occurredOn, e.amountMinor, e.currency, e.description]),
    ).toEqual(purchases.map((p) => [p.date, p.amountMinor, p.currency, p.merchant]));
  });

  it('matches a re-sent statement against the sealed rows, so it records nothing new', async () => {
    await sealPersonalLedger(deps, alice, NOW);
    await unlockPersonalLedger(deps, alice, NOW);
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    const again = preview();

    expect([again.fresh.length, again.matched.length]).toEqual([0, 6]);
    expect(recordStatement(deps, { user: alice, now: NOW })).toMatchObject({ count: 0 });
    expect(stored()).toHaveLength(6);
  });
});

describe('recordStatement', () => {
  it('records each card purchase with its transaction date and original amount', () => {
    const purchases = purchasesOf(TWO_PAGE_ROWS);
    expect(purchases).toHaveLength(6);
    preview();

    const result = recordStatement(deps, { user: alice, now: NOW });

    expect(result).toMatchObject({
      kind: 'recorded',
      count: 6,
      totals: [
        { amountMinor: 45000 + 123456 + 200000 + 45000, currency: 'RSD' },
        { amountMinor: 1500, currency: 'USD' },
        { amountMinor: 30, currency: 'EUR' },
      ],
    });
    expect(stored()).toEqual(
      purchases.map((p) => ({
        amount_minor: p.amountMinor,
        currency: p.currency,
        occurred_on: p.date,
        // Noon in Belgrade, CEST in September.
        occurred_at: `${p.date}T10:00:00.000Z`,
        description: p.merchant,
      })),
    );
    expect(stored()).toContainEqual(
      expect.objectContaining({ amount_minor: 1500, currency: 'USD', occurred_on: '2026-09-07' }),
    );
  });

  it('keys each row by its fingerprint and the ledger', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    const keys = db.prepare('SELECT source_key FROM expenses').pluck().all() as string[];
    expect(new Set(keys).size).toBe(6);
    for (const key of keys) expect(key).toMatch(/^stmt:raiffeisen-rs:[0-9a-f]{64}:[0-9a-f-]{36}$/);
  });

  it('records nothing on a second tap, and answers it as expired', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    expect(recordStatement(deps, { user: alice, now: NOW })).toEqual({ kind: 'expired' });
    expect(stored()).toHaveLength(6);
  });

  it('answers a tap after the TTL as expired and records nothing', () => {
    preview();

    const later = new Date(NOW.getTime() + 11 * 60 * 1000);

    expect(recordStatement(deps, { user: alice, now: later })).toEqual({ kind: 'expired' });
    expect(stored()).toEqual([]);
  });

  it('logs counts only: no merchant, amount or account', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      // The account number holds 13 zeros in a row; the test ids hold at most 12.
      expect(line).not.toMatch(/PRIMER|EXAMPLE|\b45000\b|\b1500\b|0{13}/);
    }
  });
});
