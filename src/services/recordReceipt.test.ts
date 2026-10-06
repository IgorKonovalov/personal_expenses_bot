import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { updateUserTimezone, type User } from '../db/users.js';
import { decodeRsUrl } from '../domain/receipts/rsUrl.js';
import { buildRsUrl, type RsVlFields } from '../domain/receipts/testing/buildRsVl.js';
import type { DecodedReceipt } from '../domain/receipts/types.js';
import { createLogger } from '../logger.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import { RECEIPTS_PER_DAY, recordReceipt } from './recordReceipt.js';

const SENT = new Date('2026-10-01T08:00:00Z');

let db: Db;
let deps: RecordDeps;
let logLines: string[];
let alice: User;
let bob: User;

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
});

function decoded(fields: RsVlFields = {}): DecodedReceipt {
  const result = decodeRsUrl(buildRsUrl(fields));
  if (result.kind !== 'receipt') throw new Error('synthetic receipt did not decode');
  return result.receipt;
}

function record(user: User, receipt = decoded(), occurredAt = SENT) {
  return recordReceipt(deps, { user, receipt, placeholder: 'Чек', occurredAt, now: occurredAt });
}

function rows(sql: string): unknown[] {
  return db.prepare(sql).all();
}

describe('recordReceipt', () => {
  it('records the total in RSD, dated the local issue day, in «Другое», with a pending receipt', () => {
    const result = record(alice);

    expect(result).toMatchObject({ kind: 'recorded', duplicate: false });
    expect(
      rows(
        `SELECT e.amount_minor, e.currency, e.description, e.occurred_at, e.occurred_on,
                e.source_key, c.name AS category
           FROM expenses e JOIN categories c ON c.id = e.category_id`,
      ),
    ).toEqual([
      {
        amount_minor: 82912,
        currency: 'RSD',
        description: 'Чек',
        occurred_at: '2026-10-01T08:00:00.000Z',
        // Belgrade: 2026-09-30T22:30Z is 00:30 on the 1st.
        occurred_on: '2026-10-01',
        source_key: `rcpt:RS:AAAA1111-AAAA1111-16898:${result.kind === 'recorded' ? result.ledger.id : ''}`,
        category: 'Другое',
      },
    ]);
    expect(rows('SELECT fiscal_id, fetch_state, attempts FROM receipts')).toEqual([
      { fiscal_id: 'AAAA1111-AAAA1111-16898', fetch_state: 'pending', attempts: 0 },
    ]);
  });

  it('dates the receipt in the user timezone: London gets the 30th', () => {
    updateUserTimezone(db, alice.id, 'Europe/London');

    record({ ...alice, timezone: 'Europe/London' });

    expect(rows('SELECT occurred_on FROM expenses')).toEqual([{ occurred_on: '2026-09-30' }]);
  });

  it('records the same receipt once per ledger, and again in another user ledger', () => {
    const first = record(alice);
    const again = record(alice);
    const other = record(bob);

    expect(again).toMatchObject({ kind: 'recorded', duplicate: true });
    if (first.kind !== 'recorded' || again.kind !== 'recorded' || other.kind !== 'recorded') return;
    expect(again.expense.id).toBe(first.expense.id);
    expect(other.duplicate).toBe(false);
    expect(other.ledger.id).not.toBe(first.ledger.id);
    expect(rows('SELECT COUNT(*) AS n FROM expenses')).toEqual([{ n: 2 }]);
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 2 }]);
  });

  it('refuses a receipt issued after the local date of the message and records nothing', () => {
    // Issued 2026-10-02T10:00Z, sent 2026-10-01T08:00Z.
    const result = record(alice, decoded({ issuedMs: Date.parse('2026-10-02T10:00:00Z') }));

    expect(result).toEqual({ kind: 'futureReceipt' });
    expect(rows('SELECT COUNT(*) AS n FROM expenses')).toEqual([{ n: 0 }]);
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 0 }]);
  });

  it('takes the category of the last receipt from the same shop', () => {
    const first = record(alice);
    if (first.kind !== 'recorded') return;
    const groceries = db
      .prepare<[string], number>(
        "SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'groceries'",
      )
      .pluck()
      .get(first.ledger.id);
    db.prepare('UPDATE expenses SET category_id = ?, category_set_at = ?').run(
      groceries,
      '2026-10-01T09:00:00.000Z',
    );

    const second = record(alice, decoded({ totalCounter: 16899 }));

    expect(second).toMatchObject({ kind: 'recorded', expense: { category: { name: 'Продукты' } } });
  });

  it('logs ids and the country, never the amount or the fiscal id', () => {
    record(alice);
    record(alice);

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain('AAAA1111');
      expect(line).not.toContain('82912');
      expect(line).not.toContain('suf.purs');
    }
    expect(JSON.parse(logLines.at(-1) ?? '{}')).toMatchObject({ country: 'RS', level: 30 });
  });
});

describe('the daily receipt cap', () => {
  // A distinct fiscal id per counter.
  const receipt = (totalCounter: number) => decoded({ totalCounter });
  const capped = (n: number, at: Date) =>
    recordReceipt(deps, {
      user: alice,
      receipt: receipt(n),
      placeholder: 'Чек',
      occurredAt: at,
      now: at,
      dailyCap: RECEIPTS_PER_DAY,
    });

  it('refuses the 21st on the Belgrade day and takes one at the next local midnight', () => {
    // 2026-10-05 in Belgrade (UTC+2) runs from 2026-10-04T22:00Z to 2026-10-05T22:00Z.
    const dayStart = Date.parse('2026-10-04T22:00:00Z');
    for (let n = 1; n <= 20; n += 1) {
      // 00:00, 01:00, … 19:00 local.
      expect(capped(n, new Date(dayStart + (n - 1) * 3_600_000)).kind).toBe('recorded');
    }

    // 23:59 local.
    expect(capped(21, new Date('2026-10-05T21:59:00Z'))).toEqual({ kind: 'capReached' });
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 20 }]);

    // A receipt already recorded still answers as recorded past the cap, and adds nothing.
    expect(capped(3, new Date('2026-10-05T21:59:00Z'))).toMatchObject({
      kind: 'recorded',
      duplicate: true,
    });

    // 00:00 local on 2026-10-06.
    expect(capped(21, new Date('2026-10-05T22:00:00Z'))).toMatchObject({
      kind: 'recorded',
      duplicate: false,
    });
    expect(rows('SELECT COUNT(*) AS n FROM receipts')).toEqual([{ n: 21 }]);
  });

  it('applies no cap when none is given', () => {
    const at = new Date('2026-10-05T10:00:00Z');
    for (let n = 1; n <= 21; n += 1) {
      expect(
        recordReceipt(deps, {
          user: alice,
          receipt: receipt(n),
          placeholder: 'Чек',
          occurredAt: at,
          now: at,
        }).kind,
      ).toBe('recorded');
    }
  });
});
