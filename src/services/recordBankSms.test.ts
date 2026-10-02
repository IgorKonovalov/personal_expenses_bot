import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { updateUserTimezone, type User } from '../db/users.js';
import { parseBankSms } from '../domain/bankSms/index.js';
import {
  buildKoriscenjeSms,
  type KoriscenjeSmsFields,
} from '../domain/bankSms/testing/buildKoriscenjeSms.js';
import type { BankSmsPurchase } from '../domain/bankSms/types.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordBankSms } from './recordBankSms.js';
import type { RecordDeps } from './recordExpense.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

// The synthetic SMS's purchase is 2026-09-14T22:30:00Z, 00:30 on the 15th in Belgrade.
const SENT = new Date('2026-09-15T08:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let logLines: string[];
let alice: User;
let bob: User;
let messages: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, SENT);
  let n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => SENT),
  };
  const provision = (externalId: string) =>
    provisionUser(deps, {
      provider: 'telegram',
      externalId,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: SENT,
    }).user;
  alice = provision('1001');
  bob = provision('1002');
  messages = 0;
});

function sms(fields: KoriscenjeSmsFields = {}): BankSmsPurchase {
  const result = parseBankSms(buildKoriscenjeSms(fields));
  if (result.kind !== 'purchase') throw new Error('synthetic SMS did not parse');
  return result;
}

// Each call is a new Telegram message unless `messageKey` names one.
function record(
  user: User,
  purchase = sms(),
  occurredAt = SENT,
  messageKey = `tg:${user.id}:${String(++messages)}`,
) {
  return recordBankSms(deps, { user, sms: purchase, messageKey, occurredAt, now: occurredAt });
}

// A record expected to land: anything else fails the test.
function recorded(user: User, purchase = sms(), occurredAt = SENT, messageKey?: string) {
  const result = record(user, purchase, occurredAt, messageKey);
  if (result.kind !== 'recorded') throw new Error(`expected a record, got ${result.kind}`);
  return result;
}

function rows(sql: string): unknown[] {
  return db.prepare(sql).all();
}

describe('recordBankSms', () => {
  it('records the charge in USD, dated the local purchase day, keyed by the content', () => {
    const purchase = sms();
    const result = recorded(alice, purchase);

    expect(result).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(
      rows(
        `SELECT e.amount_minor, e.currency, e.description, e.occurred_at, e.occurred_on,
                e.source_key, c.name AS category
           FROM expenses e JOIN categories c ON c.id = e.category_id`,
      ),
    ).toEqual([
      {
        amount_minor: 600,
        currency: 'USD',
        description: 'EXAMPLE.COM',
        occurred_at: '2026-09-15T08:00:00.000Z',
        occurred_on: '2026-09-15',
        source_key: `sms:koriscenje-kartice:${purchase.fingerprint}:${result.ledger.id}`,
        category: 'Другое',
      },
    ]);
  });

  it('dates the purchase in the user timezone: New York gets the 14th', () => {
    updateUserTimezone(db, alice.id, 'America/New_York');

    record({ ...alice, timezone: 'America/New_York' });

    expect(rows('SELECT occurred_on FROM expenses')).toEqual([{ occurred_on: '2026-09-14' }]);
  });

  it('records the same SMS once per ledger, and again in another user ledger', () => {
    const first = recorded(alice);
    const again = recorded(alice, sms({ lineEnd: '\r\n' }), new Date('2026-09-15T09:00:00Z'));
    const other = recorded(bob);

    expect(again.duplicate).toBe(true);
    expect(again.expense.id).toBe(first.expense.id);
    expect(other.duplicate).toBe(false);
    expect(other.ledger.id).not.toBe(first.ledger.id);
    expect(rows('SELECT COUNT(*) AS n FROM expenses')).toEqual([{ n: 2 }]);
  });

  it('refuses an SMS dated after the local date of the message and records nothing', () => {
    // 10:00 in Belgrade on the 16th, sent at 10:00 on the 15th.
    const result = record(alice, sms({ datum: '16.09.2026 10:00:00' }));

    expect(result).toEqual({ kind: 'futureSms' });
    expect(rows('SELECT COUNT(*) AS n FROM expenses')).toEqual([{ n: 0 }]);
  });

  it('records an SMS from ten minutes before, just past local midnight', () => {
    // 00:30 in Belgrade, sent at 00:40 on the same local day.
    const result = record(alice, sms(), new Date('2026-09-14T22:40:00Z'));

    expect(result).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(rows('SELECT occurred_on FROM expenses')).toEqual([{ occurred_on: '2026-09-15' }]);
  });

  it('takes the category the merchant was last moved to', () => {
    const first = recorded(alice);
    const groceries = db
      .prepare<[string], number>(
        "SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'groceries'",
      )
      .pluck()
      .get(first.ledger.id);
    db.prepare('UPDATE expenses SET category_id = ?, category_set_at = ?').run(
      groceries,
      '2026-09-15T08:30:00.000Z',
    );

    const second = record(alice, sms({ iznos: '9,00 USD', datum: '15.09.2026 09:00:00' }));

    expect(second).toMatchObject({
      duplicate: false,
      expense: { amountMinor: 900, category: { name: 'Продукты' } },
    });
  });

  it('logs ids and the template, never the amount, merchant or fingerprint', () => {
    const purchase = sms();
    record(alice, purchase);
    record(alice, purchase);

    expect(logLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { msg: 'bank sms recorded', template: 'koriscenje-kartice', level: 30 },
      { msg: 'duplicate bank sms', template: 'koriscenje-kartice', level: 30 },
    ]);
    for (const line of logLines) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(
        ['expenseId', 'hostname', 'level', 'msg', 'pid', 'template', 'time', 'userId'].sort(),
      );
      expect(line).not.toContain('EXAMPLE');
      expect(line).not.toContain('USD');
      expect(line).not.toContain(purchase.fingerprint);
    }
  });

  describe('in a sealed ledger', () => {
    beforeEach(async () => {
      await sealPersonalLedger(deps, alice, SENT);
      await unlockPersonalLedger(deps, alice, SENT);
    });

    it('keys the row by the Telegram message, never by the fingerprint', () => {
      const purchase = sms();
      recorded(alice, purchase, SENT, 'tg:1001:77');

      expect(rows('SELECT source_key FROM expenses')).toEqual([{ source_key: 'tg:1001:77' }]);
      expect(JSON.stringify(rows('SELECT * FROM expenses'))).not.toContain(purchase.fingerprint);
    });

    it('a redelivered message records once; the same SMS in a new message records twice', () => {
      const first = recorded(alice, sms(), SENT, 'tg:1001:77');
      const redelivered = recorded(alice, sms(), SENT, 'tg:1001:77');
      const pastedAgain = recorded(alice, sms(), SENT, 'tg:1001:78');

      expect(redelivered).toMatchObject({ duplicate: true, expense: { id: first.expense.id } });
      expect(pastedAgain.duplicate).toBe(false);
      expect(pastedAgain.expense.id).not.toBe(first.expense.id);
      expect(pastedAgain.expense).toMatchObject({ amountMinor: 600, currency: 'USD' });
      expect(rows('SELECT source_key FROM expenses ORDER BY source_key')).toEqual([
        { source_key: 'tg:1001:77' },
        { source_key: 'tg:1001:78' },
      ]);
    });
  });
});
