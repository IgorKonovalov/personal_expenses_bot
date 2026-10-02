import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { sealExpenseInPlace } from '../db/expenses.js';
import { findPersonalLedger, type Ledger } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { decodeMeUrl } from '../domain/receipts/meUrl.js';
import type { FetchedReceipt } from '../domain/receipts/types.js';
import { createLogger } from '../logger.js';
import { fetchDueReceipt, receiptItems, type FetchDeps } from './fetchDueReceipt.js';
import {
  createLedgerKeyring,
  enableEncryption,
  startEnableFlow,
  type LedgerKeyring,
} from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense } from './recordExpense.js';
import { recordReceipt } from './recordReceipt.js';
import { TEST_PASSPHRASE, unlockPersonalLedger } from './testing/sealLedger.js';

// The row sealing call, spied on and passed through, so a test can fail it midway.
vi.mock('../db/expenses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/expenses.js')>();
  return { ...actual, sealExpenseInPlace: vi.fn(actual.sealExpenseInPlace) };
});

const T0 = new Date('2026-10-01T08:00:00Z');
const ME_LINK =
  'https://mapr.tax.gov.me/ic/#/verify?iic=abcdef0123456789abcdef0123456789&tin=02000000&crtd=2026-09-30T23:15:00+02:00&prc=42.50&bu=ab123cd456';
const FETCHED: FetchedReceipt = {
  sellerName: 'Synthetic Market',
  totalMinor: 4250,
  items: [
    { name: 'Hljeb', quantity: '2', totalMinor: 240 },
    { name: 'Sir', quantity: '0.535', totalMinor: 4010 },
  ],
};
// What must not survive in the file: the three descriptions (the receipt's became its seller's
// name once fetched), and the items.
const SECRETS = ['кофе', 'такси', 'Synthetic Market', 'Hljeb'];

let dir: string;
let path: string;
let db: Db;
let deps: FetchDeps & { keys: LedgerKeyring };
let user: User;
let ledger: Ledger;
let inputs: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'expenses-seal-'));
  path = join(dir, 'bot.sqlite');
  db = openDatabase(path);
  runMigrations(db, T0);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(),
    fetchers: {
      RS: () => Promise.resolve({ kind: 'fetched', receipt: FETCHED }),
      ME: () => Promise.resolve({ kind: 'fetched', receipt: FETCHED }),
    },
    placeholder: 'Чек',
  };
  user = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: T0,
  }).user;
  const personal = findPersonalLedger(db, user.id);
  if (personal === undefined) throw new Error('setup: no personal ledger');
  ledger = personal;
  inputs = 0;
  const actual = await vi.importActual<typeof import('../db/expenses.js')>('../db/expenses.js');
  vi.mocked(sealExpenseInPlace).mockReset().mockImplementation(actual.sealExpenseInPlace);

  for (const text of ['450 кофе', '1200 такси']) {
    const recorded = recordExpense(deps, {
      user,
      text,
      sourceKey: `tg:1001:${String(++inputs)}`,
      occurredAt: T0,
      now: T0,
    });
    if (recorded.kind !== 'recorded') throw new Error(`setup: ${text}`);
  }
  const decoded = decodeMeUrl(ME_LINK);
  if (decoded.kind !== 'receipt') throw new Error('setup: receipt did not decode');
  const receipt = recordReceipt(deps, {
    user,
    receipt: decoded.receipt,
    placeholder: 'Чек',
    occurredAt: T0,
    now: T0,
  });
  if (receipt.kind !== 'recorded') throw new Error('setup: receipt not recorded');
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function fetchReceipt() {
  const result = await fetchDueReceipt(deps, { now: T0, signal: new AbortController().signal });
  if (result.kind !== 'settled') throw new Error(`setup: fetch was ${result.kind}`);
}

function enable() {
  startEnableFlow(deps, user, T0);
  return enableEncryption(deps, {
    user,
    ledgerId: ledger.id,
    passphrase: TEST_PASSPHRASE,
    inputKey: `tg:1001:${String(++inputs)}`,
    now: T0,
  });
}

const count = (sql: string) => db.prepare(sql).pluck().get();

// The DB file and its WAL as the disk holds them.
function fileBytes(): Buffer {
  const wal = `${path}-wal`;
  return Buffer.concat([readFileSync(path), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);
}

const plaintextRows = () => count('SELECT COUNT(*) FROM expenses WHERE sealed IS NULL');

describe('enabling encryption on a ledger with history', () => {
  it('seals all 3 rows, folds the receipt in, and leaves no plaintext in the file or WAL', async () => {
    await fetchReceipt();
    expect(count('SELECT COUNT(*) FROM receipt_items')).toBe(2);
    const before = fileBytes();
    for (const secret of SECRETS) expect(before.includes(Buffer.from(secret))).toBe(true);

    expect(await enable()).toMatchObject({ kind: 'enabled' });

    expect(count('SELECT COUNT(*) FROM expenses WHERE sealed IS NOT NULL')).toBe(3);
    expect(
      db
        .prepare('SELECT amount_minor, description, category_id, description_key FROM expenses')
        .all(),
    ).toEqual(
      Array(3).fill({
        amount_minor: null,
        description: null,
        category_id: null,
        description_key: null,
      }),
    );
    expect(count('SELECT COUNT(*) FROM receipts')).toBe(0);
    expect(count('SELECT COUNT(*) FROM receipt_items')).toBe(0);

    db.close();
    const after = fileBytes();
    for (const secret of SECRETS) {
      expect(after.includes(Buffer.from(secret)), secret).toBe(false);
    }
  });

  it("once unlocked, the receipt expense's items open from its sealed payload", async () => {
    await fetchReceipt();
    const receiptExpense = db
      .prepare("SELECT expense_id FROM receipts WHERE seller_name = 'Synthetic Market'")
      .pluck()
      .get() as Parameters<typeof receiptItems>[1]['expenseId'];
    await enable();

    expect(receiptItems(deps, { user, expenseId: receiptExpense })).toEqual({ kind: 'locked' });

    await unlockPersonalLedger(deps, user, T0);
    expect(receiptItems(deps, { user, expenseId: receiptExpense })).toMatchObject({
      kind: 'items',
      expense: { amountMinor: 4250, currency: 'EUR', description: 'Synthetic Market' },
      sellerName: 'Synthetic Market',
      items: FETCHED.items,
    });
  });

  it('is refused while a receipt is pending, leaving every row plaintext', async () => {
    expect(await enable()).toEqual({ kind: 'pendingReceipts' });

    expect(plaintextRows()).toBe(3);
    expect(count('SELECT COUNT(*) FROM ledger_keys')).toBe(0);
    expect(count('SELECT COUNT(*) FROM receipts')).toBe(1);
  });

  it('a failure midway leaves every row plaintext and no key', async () => {
    await fetchReceipt();
    const actual = await vi.importActual<typeof import('../db/expenses.js')>('../db/expenses.js');
    let calls = 0;
    vi.mocked(sealExpenseInPlace).mockImplementation((...args) => {
      if (++calls === 2) throw new Error('injected failure');
      return actual.sealExpenseInPlace(...args);
    });

    await expect(enable()).rejects.toThrow('injected failure');

    expect(vi.mocked(sealExpenseInPlace)).toHaveBeenCalledTimes(2);
    expect(plaintextRows()).toBe(3);
    expect(count('SELECT COUNT(*) FROM ledger_keys')).toBe(0);
    expect(count('SELECT COUNT(*) FROM ledger_key_wraps')).toBe(0);
    expect(count('SELECT COUNT(*) FROM receipt_items')).toBe(2);
  });
});
