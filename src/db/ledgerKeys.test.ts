import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import {
  findKeyWrap,
  findLedgerPublicKey,
  insertKeyWrap,
  insertLedgerKeyOrIgnore,
} from './ledgerKeys.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;
const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url));

function seedLedger(db: Db): void {
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: USER,
    createdAt: NOW,
  });
  insertMember(db, { ledgerId: LEDGER, userId: USER, role: 'owner' });
}

describe('ledger keys', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, NOW);
    seedLedger(db);
  });

  it('stores one public key per ledger; a second insert changes nothing', () => {
    const first = Buffer.alloc(32, 1);
    expect(findLedgerPublicKey(db, LEDGER)).toBeUndefined();
    expect(
      insertLedgerKeyOrIgnore(db, { ledgerId: LEDGER, publicKey: first, createdAt: NOW }),
    ).toBe(true);
    expect(
      insertLedgerKeyOrIgnore(db, {
        ledgerId: LEDGER,
        publicKey: Buffer.alloc(32, 2),
        createdAt: NOW,
      }),
    ).toBe(false);
    expect(findLedgerPublicKey(db, LEDGER)?.equals(first)).toBe(true);
  });

  it('finds the member wrap and the recovery wrap apart, one of each per ledger', () => {
    insertLedgerKeyOrIgnore(db, { ledgerId: LEDGER, publicKey: Buffer.alloc(32), createdAt: NOW });
    const member = { kdf: 'argon2id' as const, kdfParams: '{"m":1}', wrappedPrivate: Buffer.of(1) };
    const recovery = {
      kdf: 'hkdf-sha256' as const,
      kdfParams: '{"r":1}',
      wrappedPrivate: Buffer.of(2),
    };
    insertKeyWrap(db, LEDGER, { wrapper: 'member', userId: USER }, member);
    insertKeyWrap(db, LEDGER, { wrapper: 'recovery' }, recovery);

    expect(findKeyWrap(db, LEDGER, { wrapper: 'member', userId: USER })).toEqual(member);
    expect(findKeyWrap(db, LEDGER, { wrapper: 'recovery' })).toEqual(recovery);
    expect(() => {
      insertKeyWrap(db, LEDGER, { wrapper: 'recovery' }, recovery);
    }).toThrow(/UNIQUE/);
    expect(() => {
      insertKeyWrap(db, LEDGER, { wrapper: 'member', userId: USER }, member);
    }).toThrow(/UNIQUE/);
  });
});

describe('migration 0012', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('rebuilds expenses keeping every row, its receipt and the receipt items', () => {
    dir = mkdtempSync(join(tmpdir(), 'expenses-mig-'));
    for (const file of readdirSync(MIGRATIONS).filter((f) => f < '0012')) {
      copyFileSync(join(MIGRATIONS, file), join(dir, file));
    }
    const db = openDatabase(':memory:');
    runMigrations(db, NOW, dir);
    seedLedger(db);
    db.exec(`
      INSERT INTO expenses (id, ledger_id, created_by, amount_minor, currency, description,
                            occurred_at, occurred_on, source_key, created_at, description_key)
      VALUES ('e1', 'ledger-a', 'user-a', 45000, 'RSD', 'кофе', '2026-10-01T08:00:00.000Z',
              '2026-10-01', 'tg:1:1', '2026-10-01T08:00:00.000Z', 'кофе');
      INSERT INTO receipts (id, expense_id, country, fiscal_id, merchant_key, verify_url,
                            issued_at, seller_name, fetch_state, created_at)
      VALUES ('r1', 'e1', 'RS', 'f1', 'rs:A', 'https://example.test/v', '2026-10-01T07:00:00.000Z',
              'Shop', 'fetched', '2026-10-01T08:00:00.000Z');
      INSERT INTO receipt_items (receipt_id, position, name, quantity, total_minor)
      VALUES ('r1', 1, 'Milk', '1', 45000);
    `);

    // Later migrations apply in the same call; 0012 is the first.
    expect(runMigrations(db, NOW)[0]).toBe('0012');

    expect(db.prepare('SELECT id, amount_minor, description, sealed FROM expenses').all()).toEqual([
      { id: 'e1', amount_minor: 45000, description: 'кофе', sealed: null },
    ]);
    expect(db.prepare('SELECT id, expense_id FROM receipts').all()).toEqual([
      { id: 'r1', expense_id: 'e1' },
    ]);
    expect(db.prepare('SELECT receipt_id, name FROM receipt_items').all()).toEqual([
      { receipt_id: 'r1', name: 'Milk' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'expenses'")
        .pluck()
        .all(),
    ).toEqual(expect.arrayContaining(['expenses_ledger_day', 'expenses_ledger_description']));
  });

  it('holds a row either plaintext or sealed, never both or neither', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, NOW);
    seedLedger(db);
    let n = 0;
    const insert = (amount: number | null, description: string | null, sealed: Buffer | null) =>
      db
        .prepare(
          `INSERT INTO expenses (id, ledger_id, created_by, amount_minor, currency, description,
                                 occurred_at, occurred_on, source_key, created_at, sealed)
           VALUES (?, 'ledger-a', 'user-a', ?, 'RSD', ?, 'x', '2026-10-01', ?, 'x', ?)`,
        )
        .run(`e-${String(++n)}`, amount, description, `tg:1:${String(n)}`, sealed);

    expect(() => insert(45000, 'кофе', null)).not.toThrow();
    expect(() => insert(null, null, Buffer.of(1))).not.toThrow();
    expect(() => insert(45000, 'кофе', Buffer.of(1))).toThrow(/CHECK/);
    expect(() => insert(null, null, null)).toThrow(/CHECK/);
    expect(() => insert(null, 'кофе', Buffer.of(1))).toThrow(/CHECK/);
  });
});
