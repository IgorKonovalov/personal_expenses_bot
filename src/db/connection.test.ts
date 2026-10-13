import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase } from './connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertReceiptItems } from './receiptItems.js';
import { insertReceipt, type ReceiptId } from './receipts.js';
import { insertUser, type UserId } from './users.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const BOOT = new Date('2026-09-29T10:00:00Z');
let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'expenses-db-'));
  return join(dir, 'nested', 'bot.sqlite');
}

describe('openDatabase', () => {
  it('creates the directory and sets WAL, busy_timeout, foreign keys and secure_delete', () => {
    const db = openDatabase(tempDbPath());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    db.close();
  });
});

describe('runMigrations', () => {
  it('applies each migration once and records it; a second boot applies nothing', () => {
    const path = tempDbPath();

    // Every migration file in the directory, in order: the list grows with each migration.
    const versions = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort()
      .map((file) => file.slice(0, 4));
    expect(versions.slice(0, 2)).toEqual(['0001', '0002']);

    const first = openDatabase(path);
    expect(runMigrations(first, BOOT)).toEqual(versions);
    first.close();

    const second = openDatabase(path);
    expect(runMigrations(second, BOOT)).toEqual([]);
    expect(second.prepare('SELECT version, applied_at FROM schema_migrations').all()).toEqual(
      versions.map((version) => ({ version, applied_at: '2026-09-29T10:00:00.000Z' })),
    );
    second.close();
  });
});

describe('migration 0030 (ADR-0052)', () => {
  it('keeps every fiscal receipt with its id and items, now of kind fiscal', () => {
    const path = tempDbPath();
    // The migrations before 0030, applied from a copy of the directory.
    const before = join(path, '..', 'migrations-0029');
    mkdirSync(before, { recursive: true });
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f))) {
      if (file.slice(0, 4) < '0030') copyFileSync(join(MIGRATIONS_DIR, file), join(before, file));
    }
    const db = openDatabase(path);
    expect(runMigrations(db, BOOT, before).at(-1)).toBe('0029');

    const user = 'user-a' as UserId;
    const ledger = 'ledger-a' as LedgerId;
    insertUser(db, { id: user, timezone: 'Europe/Belgrade', createdAt: BOOT });
    insertLedger(db, {
      id: ledger,
      kind: 'personal',
      name: 'Personal',
      defaultCurrency: 'RSD',
      ownerUserId: user,
      createdAt: BOOT,
    });
    insertMember(db, { ledgerId: ledger, userId: user, role: 'owner' });
    const receipts = [
      { id: 'receipt-rs', country: 'RS', currency: 'RSD', items: 3 },
      { id: 'receipt-me', country: 'ME', currency: 'EUR', items: 2 },
    ] as const;
    for (const [n, receipt] of receipts.entries()) {
      const expenseId = `expense-${String(n)}` as ExpenseId;
      insertExpenseOrGetExisting(db, {
        id: expenseId,
        ledgerId: ledger,
        createdBy: user,
        amountMinor: 1000,
        currency: receipt.currency,
        description: 'Чек',
        occurredAt: BOOT,
        occurredOn: '2026-09-29' as LocalDate,
        sourceKey: `rcpt:${receipt.country}:fiscal-${String(n)}:${ledger}`,
        createdAt: BOOT,
      });
      insertReceipt(db, {
        id: receipt.id as ReceiptId,
        expenseId,
        country: receipt.country,
        fiscalId: `fiscal-${String(n)}`,
        merchantKey: `${receipt.country.toLowerCase()}:shop`,
        verifyUrl: `https://example.test/${receipt.country}`,
        issuedAt: BOOT,
        createdAt: BOOT,
      });
      insertReceiptItems(
        db,
        receipt.id as ReceiptId,
        Array.from({ length: receipt.items }, (_, i) => ({
          name: `item ${String(i)}`,
          quantity: '1',
          totalMinor: 100,
        })),
      );
    }

    expect(runMigrations(db, BOOT)).toEqual(['0030']);
    expect(
      db
        .prepare(
          `SELECT r.id, r.kind, r.country, r.fiscal_id, r.verify_url, r.order_key,
                  (SELECT COUNT(*) FROM receipt_items i WHERE i.receipt_id = r.id) AS items
             FROM receipts r ORDER BY r.id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'receipt-me',
        kind: 'fiscal',
        country: 'ME',
        fiscal_id: 'fiscal-1',
        verify_url: 'https://example.test/ME',
        order_key: null,
        items: 2,
      },
      {
        id: 'receipt-rs',
        kind: 'fiscal',
        country: 'RS',
        fiscal_id: 'fiscal-0',
        verify_url: 'https://example.test/RS',
        order_key: null,
        items: 3,
      },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
