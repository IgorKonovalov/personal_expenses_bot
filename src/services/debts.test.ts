import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import type { DebtOpId } from '../db/debts.js';
import {
  answerDebtAmount,
  answerDebtPersonName,
  answerRepayAmount,
  debtLines,
  deleteDebtOp,
  personCard,
  pickDebtPerson,
  repayAll,
  startDebt,
  startRepay,
  type DebtDeps,
} from './debts.js';
import { currentFlow, type DebtAmountFlow, type DebtPersonFlow } from './flowSessions.js';
import { createLedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { sealPersonalLedger, unlockPersonalLedger } from './testing/sealLedger.js';

const NOW = new Date('2026-10-02T10:00:00Z');

let db: Db;
let deps: DebtDeps;
let logLines: string[];
let alice: User;
let n: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
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

function startLend(): DebtAmountFlow {
  const flow = startDebt(deps, alice, 'lend', NOW);
  if (flow.kind === 'locked') throw new Error('setup: locked');
  return flow;
}

// The flow up to the person step, for an amount typed as `text`.
function askPerson(text: string, key: string): DebtPersonFlow {
  const flow = startLend();
  const answer = answerDebtAmount(deps, { user: alice, flow, text, inputKey: key, now: NOW });
  if (answer.kind !== 'askPerson') throw new Error('amount refused');
  return answer.flow;
}

function lendTo(name: string, amount: string, n: number) {
  const flow = askPerson(amount, `tg:1001:${n}`);
  return answerDebtPersonName(deps, {
    user: alice,
    flow,
    text: name,
    inputKey: `tg:1001:${n + 1}`,
    now: NOW,
  });
}

describe('lending', () => {
  it('records 5000 lent to Петя as 500000 minor units RSD, dated today, and lists it', () => {
    const recorded = lendTo('Петя', '5000', 1);

    expect(recorded).toMatchObject({
      kind: 'recorded',
      op: { kind: 'lend', amountMinor: 500000, currency: 'RSD', occurredOn: '2026-10-02' },
      person: { name: 'Петя' },
      balance: { amountMinor: 500000, currency: 'RSD' },
    });
    expect(debtLines(deps, alice)).toEqual([
      expect.objectContaining({ name: 'Петя', amountMinor: 500000, currency: 'RSD' }),
    ]);
    expect(currentFlow(deps, alice, NOW)).toBeUndefined();
  });

  it('keeps a second currency apart, and «петя» reuses Петя', () => {
    lendTo('Петя', '5000', 1);
    lendTo('петя', '20 EUR', 3);

    expect(db.prepare('SELECT COUNT(*) FROM debt_people').pluck().get()).toBe(1);
    expect(debtLines(deps, alice)).toEqual([
      expect.objectContaining({ name: 'Петя', amountMinor: 2000, currency: 'EUR' }),
      expect.objectContaining({ name: 'Петя', amountMinor: 500000, currency: 'RSD' }),
    ]);
  });

  it('refuses an unreadable amount and an empty name, keeping the step', () => {
    const flow = startLend();
    expect(
      answerDebtAmount(deps, { user: alice, flow, text: 'много', inputKey: 'k1', now: NOW }),
    ).toEqual({ kind: 'invalid', currency: 'RSD' });
    const person = askPerson('5000', 'k2');
    expect(
      answerDebtPersonName(deps, {
        user: alice,
        flow: person,
        text: ' ',
        inputKey: 'k3',
        now: NOW,
      }),
    ).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(currentFlow(deps, alice, NOW)).toEqual(person);
  });

  it('a picked person is recorded once per tap key, and a second tap is stale', () => {
    const first = lendTo('Петя', '5000', 1);
    if (first.kind !== 'recorded') throw new Error('setup');
    askPerson('100', 'tg:1001:3');

    const pick = (sourceKey: string) =>
      pickDebtPerson(deps, { user: alice, personId: first.person.id, sourceKey, now: NOW });
    expect(pick('cb:1')).toMatchObject({ kind: 'recorded', balance: { amountMinor: 510000 } });
    expect(pick('cb:1')).toMatchObject({ kind: 'recorded', balance: { amountMinor: 510000 } });
    expect(pick('cb:2')).toEqual({ kind: 'stale' });
    expect(db.prepare('SELECT COUNT(*) FROM debt_ops').pluck().get()).toBe(2);
  });

  it('logs no name and no amount', () => {
    lendTo('Синтетик', '4321', 1);

    expect(logLines.some((line) => line.includes('debt recorded'))).toBe(true);
    for (const line of logLines) {
      // The clock and process fields carry unrelated digits.
      const content = JSON.stringify(
        Object.entries(JSON.parse(line) as Record<string, unknown>).filter(
          ([key]) => !['time', 'pid', 'hostname'].includes(key),
        ),
      );
      expect(content).not.toContain('Синтетик');
      expect(content).not.toContain('4321');
    }
  });
});

describe('in a sealed personal ledger (ADR-0020)', () => {
  async function sealed() {
    const ledger = await sealPersonalLedger(deps, alice, NOW);
    await unlockPersonalLedger(deps, alice, NOW);
    return ledger;
  }

  it('seals the name and the operation, opens them while unlocked, and «петя» reuses Петя', async () => {
    await sealed();
    lendTo('Петя', '5000', 1);
    lendTo('петя', '20 EUR', 3);

    const people = db.prepare('SELECT name, name_key, sealed FROM debt_people').all() as {
      name: string | null;
      name_key: string | null;
      sealed: Buffer;
    }[];
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ name: null, name_key: null });
    expect(people[0]?.sealed.includes(Buffer.from('Петя', 'utf8'))).toBe(false);
    expect(
      db
        .prepare('SELECT kind, amount_minor, currency, sealed IS NOT NULL AS sealed FROM debt_ops')
        .all(),
    ).toEqual([
      { kind: null, amount_minor: null, currency: null, sealed: 1 },
      { kind: null, amount_minor: null, currency: null, sealed: 1 },
    ]);
    expect(debtLines(deps, alice)).toEqual([
      expect.objectContaining({ name: 'Петя', amountMinor: 2000, currency: 'EUR' }),
      expect.objectContaining({ name: 'Петя', amountMinor: 500000, currency: 'RSD' }),
    ]);
  });

  it('keeps a debt recorded before sealing readable next to a sealed one', async () => {
    lendTo('Петя', '5000', 1);
    await sealed();
    lendTo('Петя', '1000', 3);

    expect(db.prepare('SELECT COUNT(*) FROM debt_people').pluck().get()).toBe(1);
    expect(debtLines(deps, alice)).toEqual([
      expect.objectContaining({ name: 'Петя', amountMinor: 600000, currency: 'RSD' }),
    ]);
  });

  it('while locked reads and records nothing, and deletes nothing', async () => {
    const ledger = await sealed();
    const recorded = lendTo('Петя', '5000', 1);
    if (recorded.kind !== 'recorded') throw new Error('setup');
    deps.keys.lock(ledger.id);

    expect(debtLines(deps, alice)).toEqual({ kind: 'locked' });
    expect(startDebt(deps, alice, 'lend', NOW)).toEqual({ kind: 'locked' });
    expect(personCard(deps, alice, recorded.person.id)).toEqual({ kind: 'locked' });
    expect(deleteDebtOp(deps, { user: alice, opId: recorded.op.id, now: NOW })).toEqual({
      kind: 'locked',
    });
    expect(db.prepare('SELECT deleted_at FROM debt_ops').pluck().get()).toBeNull();

    await unlockPersonalLedger(deps, alice, NOW);
    expect(debtLines(deps, alice)).toEqual([
      expect.objectContaining({ name: 'Петя', amountMinor: 500000, currency: 'RSD' }),
    ]);
  });
});

describe('repaying', () => {
  // Петя owes 5000 RSD and 20 EUR.
  function petya() {
    const first = lendTo('Петя', '5000', 1);
    lendTo('Петя', '20 EUR', 3);
    if (first.kind !== 'recorded') throw new Error('setup');
    return first.person.id;
  }

  it('asks for the currency when two balances point the same way', () => {
    const personId = petya();

    expect(startRepay(deps, { user: alice, personId, direction: 'toMe', now: NOW })).toEqual({
      kind: 'pickCurrency',
      balances: [
        { amountMinor: 2000, currency: 'EUR' },
        { amountMinor: 500000, currency: 'RSD' },
      ],
    });
    expect(startRepay(deps, { user: alice, personId, direction: 'byMe', now: NOW })).toEqual({
      kind: 'nothing',
    });
  });

  it('refuses another currency and more than the balance, then records 2000 of 5000', () => {
    const personId = petya();
    const start = startRepay(deps, {
      user: alice,
      personId,
      direction: 'toMe',
      currency: 'RSD',
      now: NOW,
    });
    if (start.kind !== 'askAmount') throw new Error('setup');
    const answer = (text: string, inputKey: string) =>
      answerRepayAmount(deps, { user: alice, flow: start.flow, text, inputKey, now: NOW });

    expect(answer('20 USD', 'k1')).toMatchObject({ kind: 'refused', reason: 'wrongCurrency' });
    expect(answer('5000,01', 'k2')).toMatchObject({ kind: 'refused', reason: 'tooMuch' });
    expect(answer('2000', 'k3')).toMatchObject({
      kind: 'recorded',
      op: { kind: 'repaid_to_me', amountMinor: 200000, currency: 'RSD' },
      balance: { amountMinor: 300000, currency: 'RSD' },
    });
  });

  it('[Весь долг] repays the whole balance once, and deleting it brings the balance back', () => {
    const personId = petya();
    startRepay(deps, { user: alice, personId, direction: 'toMe', currency: 'EUR', now: NOW });

    const all = repayAll(deps, { user: alice, sourceKey: 'cb:1', now: NOW });
    expect(all).toMatchObject({ kind: 'recorded', balance: { amountMinor: 0, currency: 'EUR' } });
    expect(repayAll(deps, { user: alice, sourceKey: 'cb:2', now: NOW })).toEqual({
      kind: 'stale',
    });
    if (all.kind !== 'recorded') throw new Error('setup');

    const del = (opId: DebtOpId) => deleteDebtOp(deps, { user: alice, opId, now: NOW });
    expect(del(all.op.id)).toMatchObject({
      kind: 'deleted',
      balance: { amountMinor: 2000, currency: 'EUR' },
    });
    expect(del(all.op.id)).toEqual({ kind: 'alreadyDeleted' });
  });
});
