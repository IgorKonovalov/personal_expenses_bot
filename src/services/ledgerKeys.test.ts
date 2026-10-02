import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { listLedgerExpensesOn } from '../db/expenses.js';
import { findPersonalLedger, type Ledger } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { routeText } from './flowSessions.js';
import {
  changePassphrase,
  createLedgerKeyring,
  enableEncryption,
  encryptionState,
  lockLedger,
  openExpenses,
  recoverWithCode,
  startEnableFlow,
  startPassphraseChange,
  startRecoverFlow,
  startUnlockFlow,
  unlockLedger,
  type LedgerKeyring,
} from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';
import { scrubFreedPages } from './sealLedger.js';
import { todaySummary } from './todaySummary.js';

// The post-seal scrub, spied on and passed through, so a test can fail it.
vi.mock('./sealLedger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sealLedger.js')>();
  return { ...actual, scrubFreedPages: vi.fn(actual.scrubFreedPages) };
});

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
    keys: createLedgerKeyring(() => NOW),
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

  it('still returns the recovery code when the scrub after the seal fails', async () => {
    const lines: string[] = [];
    deps = {
      ...deps,
      logger: createLogger('warn', { write: (line: string) => void lines.push(line) }),
    };
    vi.mocked(scrubFreedPages).mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL');
    });

    const result = await enable();

    expect(result).toMatchObject({ kind: 'enabled' });
    if (result.kind !== 'enabled') return;
    expect(result.recoveryCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
    // The code shown is the one the committed recovery wrap opens with.
    expect(startRecoverFlow(deps, user, NOW)).toBe('asked');
    expect(
      recoverWithCode(deps, {
        user,
        ledgerId: ledger.id,
        code: result.recoveryCode,
        inputKey: `tg:1001:${String(++inputs)}`,
        now: NOW,
      }),
    ).toEqual({ kind: 'recovered' });
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual([
      'scrub after sealing failed',
    ]);
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

    expect(encryptionState({ ...deps, keys: createLedgerKeyring(() => NOW) }, user).kind).toBe(
      'locked',
    );
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

describe('recovery and passphrase change', () => {
  async function enabledCode(): Promise<string> {
    const result = await enable();
    if (result.kind !== 'enabled') throw new Error('setup: not enabled');
    return result.recoveryCode;
  }

  function recover(code: string) {
    expect(startRecoverFlow(deps, user, NOW)).toBe('asked');
    return recoverWithCode(deps, {
      user,
      ledgerId: ledger.id,
      code,
      inputKey: `tg:1001:${String(++inputs)}`,
      now: NOW,
    });
  }

  function newPassphrase(passphrase: string) {
    return changePassphrase(deps, {
      user,
      ledgerId: ledger.id,
      passphrase,
      inputKey: `tg:1001:${String(++inputs)}`,
    });
  }

  const wraps = () =>
    db.prepare('SELECT wrapper, kdf_params, wrapped_private FROM ledger_key_wraps').all();

  it('/recover with the code, then a new passphrase Y: Y unlocks and the old one is refused', async () => {
    const code = await enabledCode();
    const recoveryWrap = db
      .prepare("SELECT wrapped_private FROM ledger_key_wraps WHERE wrapper = 'recovery'")
      .pluck()
      .get();

    // Typed in lower case with spaces instead of dashes.
    expect(recover(code.toLowerCase().replaceAll('-', ' '))).toEqual({ kind: 'recovered' });
    expect(routeText(deps, { user, inputKey: 'tg:1001:900', now: NOW })).toEqual({
      kind: 'flow',
      flow: { kind: 'recoverPassphrase', ledgerId: ledger.id },
    });
    expect(await newPassphrase('new passphrase Y')).toEqual({ kind: 'changed' });
    deps.keys.lock(ledger.id);

    expect(await unlock(PASSPHRASE)).toEqual({ kind: 'wrongPassphrase' });
    expect(await unlock('new passphrase Y')).toEqual({ kind: 'unlocked' });
    expect(
      db
        .prepare("SELECT wrapped_private FROM ledger_key_wraps WHERE wrapper = 'recovery'")
        .pluck()
        .get(),
    ).toEqual(recoveryWrap);
  });

  it('a wrong recovery code changes nothing and leaves the ledger locked', async () => {
    const code = await enabledCode();
    const before = wraps();
    // The right length and alphabet, one character off.
    const wrong = `${code.startsWith('A') ? 'B' : 'A'}${code.slice(1)}`;

    expect(recover(wrong)).toEqual({ kind: 'wrongCode' });
    expect(recover('not a code')).toEqual({ kind: 'wrongCode' });

    expect(wraps()).toEqual(before);
    expect(encryptionState(deps, user).kind).toBe('locked');
    expect(routeText(deps, { user, inputKey: 'tg:1001:900', now: NOW }).kind).toBe('free');
  });

  it('after a passphrase change the sealed rows still open: the keypair is unchanged', async () => {
    await enabledCode();
    record('450 кофе');
    const publicKey: unknown = db.prepare('SELECT public_key FROM ledger_keys').pluck().get();
    await unlock(PASSPHRASE);

    expect(startPassphraseChange(deps, user, NOW)).toBe('asked');
    expect(await newPassphrase('short')).toEqual({ kind: 'tooShort' });
    expect(await newPassphrase('another passphrase')).toEqual({ kind: 'changed' });
    deps.keys.lock(ledger.id);
    expect(await unlock('another passphrase')).toEqual({ kind: 'unlocked' });

    expect(db.prepare('SELECT public_key FROM ledger_keys').pluck().get()).toEqual(publicKey);
    const opened = openExpenses(deps, ledger.id, todayRows());
    expect(opened.kind === 'open' && opened.expenses.map((e) => e.description)).toEqual(['кофе']);
  });

  it('a passphrase change is not offered while locked', async () => {
    await enabledCode();
    expect(startPassphraseChange(deps, user, NOW)).toBe('locked');
  });
});

describe('the idle lock', () => {
  // 12:00 local (CEST) on the 30th, and minutes after it.
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  let clock: { now: Date };

  async function unlockedAtNoon() {
    clock = { now: at(0) };
    deps = { ...deps, keys: createLedgerKeyring(() => clock.now) };
    await enable();
    await unlock(PASSPHRASE);
  }

  function today(minutes: number) {
    clock.now = at(minutes);
    return 'kind' in todaySummary(deps, { user, now: clock.now }) ? 'locked' : 'open';
  }

  it('a read at 12:10 slides the expiry to 12:40, so a read at 12:39 opens', async () => {
    await unlockedAtNoon();
    expect(today(10)).toBe('open');
    expect(today(39)).toBe('open');
  });

  it('without the 12:39 read, a read at 12:41 is locked', async () => {
    await unlockedAtNoon();
    expect(today(10)).toBe('open');
    expect(today(41)).toBe('locked');
    expect(encryptionState(deps, user).kind).toBe('locked');
  });

  it('a status check is no read: it slides nothing', async () => {
    await unlockedAtNoon();
    clock.now = at(29);
    expect(encryptionState(deps, user).kind).toBe('unlocked');
    expect(today(30)).toBe('locked');
  });

  it('/lock locks at once; a second /lock finds it locked', async () => {
    await unlockedAtNoon();
    expect(lockLedger(deps, user)).toBe('locked');
    expect(today(1)).toBe('locked');
    expect(lockLedger(deps, user)).toBe('alreadyLocked');
  });
});
