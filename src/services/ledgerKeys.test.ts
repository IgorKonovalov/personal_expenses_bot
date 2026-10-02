import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { listLedgerExpensesOn } from '../db/expenses.js';
import { findPersonalLedger, type Ledger } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { routeText } from './flowSessions.js';
import {
  createLedgerKeyring,
  enableEncryption,
  encryptionState,
  openExpenses,
  startEnableFlow,
  startUnlockFlow,
  unlockLedger,
  type LedgerKeyring,
} from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const TODAY = '2026-09-30' as LocalDate;
const PASSPHRASE = 'correct horse 42';

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let ledger: Ledger;
let inputs: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(),
  };
  user = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
  const personal = findPersonalLedger(db, user.id);
  if (personal === undefined) throw new Error('setup: no personal ledger');
  ledger = personal;
  inputs = 0;
});

function enable(passphrase = PASSPHRASE) {
  startEnableFlow(deps, user, NOW);
  return enableEncryption(deps, {
    user,
    ledgerId: ledger.id,
    passphrase,
    inputKey: `tg:1001:${String(++inputs)}`,
    now: NOW,
  });
}

function unlock(passphrase: string) {
  expect(startUnlockFlow(deps, user, NOW)).toBe('asked');
  return unlockLedger(deps, {
    user,
    ledgerId: ledger.id,
    passphrase,
    inputKey: `tg:1001:${String(++inputs)}`,
  });
}

function record(text: string) {
  return recordExpense(deps, {
    user,
    text,
    sourceKey: `tg:1001:${String(++inputs)}`,
    occurredAt: NOW,
    now: NOW,
  });
}

function todayRows() {
  return listLedgerExpensesOn(db, { ledgerId: ledger.id, memberId: user.id, occurredOn: TODAY });
}

describe('enableEncryption', () => {
  it('stores a public key and two wraps, returns a recovery code, and leaves the ledger locked', async () => {
    const result = await enable();

    expect(result).toMatchObject({ kind: 'enabled' });
    if (result.kind !== 'enabled') return;
    expect(result.recoveryCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(1);
    expect(db.prepare('SELECT wrapper, kdf FROM ledger_key_wraps ORDER BY wrapper').all()).toEqual([
      { wrapper: 'member', kdf: 'argon2id' },
      { wrapper: 'recovery', kdf: 'hkdf-sha256' },
    ]);
    expect(encryptionState(deps, user).kind).toBe('locked');
  });

  it('accepts a passphrase of exactly 10 characters', async () => {
    expect(await enable('short pass')).toMatchObject({ kind: 'enabled' });
  });

  it('a 9-character passphrase is refused, nothing stored, the flow still pending', async () => {
    startEnableFlow(deps, user, NOW);
    const result = await enableEncryption(deps, {
      user,
      ledgerId: ledger.id,
      passphrase: '123456789',
      inputKey: 'tg:1001:1',
      now: NOW,
    });

    expect(result).toEqual({ kind: 'tooShort' });
    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(0);
    expect(routeText(deps, { user, inputKey: 'tg:1001:2', now: NOW })).toEqual({
      kind: 'flow',
      flow: { kind: 'encryptionEnable', ledgerId: ledger.id },
    });
  });

  it('a second enable creates no second keypair or wrap', async () => {
    await enable();
    const publicKey: unknown = db.prepare('SELECT public_key FROM ledger_keys').pluck().get();

    expect(startEnableFlow(deps, user, NOW)).toBe(false);
    expect(db.prepare('SELECT public_key FROM ledger_keys').pluck().get()).toEqual(publicKey);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_key_wraps').pluck().get()).toBe(2);
  });

  it('seals the expenses already recorded, which open once unlocked', async () => {
    record('450 кофе');

    expect(await enable()).toMatchObject({ kind: 'enabled' });
    expect(db.prepare('SELECT amount_minor, description FROM expenses').all()).toEqual([
      { amount_minor: null, description: null },
    ]);
    await unlock(PASSPHRASE);
    const opened = openExpenses(deps, ledger.id, todayRows());
    expect(opened.kind === 'open' && opened.expenses.map((e) => e.amountMinor)).toEqual([45000]);
  });
});

describe('a sealed ledger', () => {
  it('records sealed rows that read as locked until the right passphrase unlocks them', async () => {
    await enable();
    expect(record('450 кофе')).toMatchObject({
      kind: 'recorded',
      expense: { amountMinor: 45000, description: 'кофе' },
    });
    record('1200 такси');

    expect(
      db
        .prepare('SELECT amount_minor, description, category_id, description_key FROM expenses')
        .all(),
    ).toEqual([
      { amount_minor: null, description: null, category_id: null, description_key: null },
      { amount_minor: null, description: null, category_id: null, description_key: null },
    ]);
    expect(openExpenses(deps, ledger.id, todayRows())).toEqual({ kind: 'locked' });

    expect(await unlock(`${PASSPHRASE}!`)).toEqual({ kind: 'wrongPassphrase' });
    expect(openExpenses(deps, ledger.id, todayRows())).toEqual({ kind: 'locked' });

    expect(await unlock(PASSPHRASE)).toEqual({ kind: 'unlocked' });
    const opened = openExpenses(deps, ledger.id, todayRows());
    expect(opened.kind).toBe('open');
    if (opened.kind !== 'open') return;
    expect(opened.expenses.map((e) => [e.amountMinor, e.description, e.category?.name])).toEqual([
      [45000, 'кофе', 'Кафе и рестораны'],
      [120000, 'такси', 'Транспорт'],
    ]);
  });

  it('reads as locked even with no rows, and a plaintext ledger never does', async () => {
    expect(openExpenses(deps, ledger.id, [])).toEqual({ kind: 'open', expenses: [] });
    await enable();
    expect(openExpenses(deps, ledger.id, [])).toEqual({ kind: 'locked' });
  });

  it('a fresh keyring over the same DB starts locked', async () => {
    await enable();
    await unlock(PASSPHRASE);
    expect(encryptionState(deps, user).kind).toBe('unlocked');

    expect(encryptionState({ ...deps, keys: createLedgerKeyring() }, user).kind).toBe('locked');
  });

  it('a redelivered expense in a locked ledger records nothing new and shows nothing', async () => {
    await enable();
    const sourceKey = 'tg:1001:99';
    const first = recordExpense(deps, {
      user,
      text: '450 кофе',
      sourceKey,
      occurredAt: NOW,
      now: NOW,
    });
    const again = recordExpense(deps, {
      user,
      text: '450 кофе',
      sourceKey,
      occurredAt: NOW,
      now: NOW,
    });

    expect(first.kind).toBe('recorded');
    expect(again).toEqual({ kind: 'sealedDuplicate' });
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
  });
});
