import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import {
  answerDebtAmount,
  answerDebtPersonName,
  debtLines,
  pickDebtPerson,
  startDebt,
  type DebtDeps,
} from './debts.js';
import { currentFlow, type DebtPersonFlow } from './flowSessions.js';
import { createLedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';

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

// The flow up to the person step, for an amount typed as `text`.
function askPerson(text: string, key: string): DebtPersonFlow {
  const flow = startDebt(deps, alice, 'lend', NOW);
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
    const flow = startDebt(deps, alice, 'lend', NOW);
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
