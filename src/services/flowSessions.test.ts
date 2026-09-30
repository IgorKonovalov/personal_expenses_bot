import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import {
  cancelFlow,
  completeFlow,
  currentAnchor,
  routeText,
  setAnchor,
  startFlow,
} from './flowSessions.js';
import { provisionUser } from './provisionUser.js';

const T = new Date('2026-09-30T10:00:00Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const MIN = 60 * 1000;

let db: Db;
let user: User;
let ledgerId: LedgerId;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, T);
  let n = 0;
  const provisioned = provisionUser(
    { db, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    {
      provider: 'telegram',
      externalId: '1001',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: T,
    },
  );
  user = provisioned.user;
  ledgerId = provisioned.ledger.id;
  setAnchor({ db }, user, { chatId: 1001, messageId: 5, screen: { name: 'categories', ledgerId } });
});

const route = (inputKey: string, now: Date) => routeText({ db }, { user, inputKey, now });

describe('screen anchor', () => {
  it('round-trips a summary screen with its ledger id', () => {
    setAnchor({ db }, user, { chatId: 1001, messageId: 6, screen: { name: 'summary', ledgerId } });

    expect(currentAnchor({ db }, user)).toEqual({
      chatId: 1001,
      messageId: 6,
      screen: { name: 'summary', ledgerId },
    });
    expect(db.prepare('SELECT screen, screen_ctx FROM flow_sessions').get()).toEqual({
      screen: 'summary',
      screen_ctx: JSON.stringify({ ledgerId }),
    });
  });

  it('reads a summary row without a ledger id as no screen', () => {
    db.prepare("UPDATE flow_sessions SET screen = 'summary', screen_ctx = '{}'").run();

    expect(currentAnchor({ db }, user)).toBeUndefined();
  });
});

describe('routeText (ADR-0009)', () => {
  it('is free text with no expired flow when nothing was ever pending', () => {
    expect(route('tg:1:1', T)).toEqual({ kind: 'free', expiredFlow: false });
  });

  it('takes the text as the answer up to 10 minutes after the prompt', () => {
    startFlow({ db }, user, { kind: 'categoryAdd', ledgerId }, T);

    expect(route('tg:1:1', at(9 * MIN + 59_000))).toEqual({
      kind: 'flow',
      flow: { kind: 'categoryAdd', ledgerId },
    });
  });

  it('reports an expired flow for 24 hours after expiry, then plain free text', () => {
    startFlow({ db }, user, { kind: 'categoryAdd', ledgerId }, T);

    expect(route('tg:1:1', at(10 * MIN + 1000))).toEqual({ kind: 'free', expiredFlow: true });
    expect(route('tg:1:1', at(25 * 60 * MIN))).toEqual({ kind: 'free', expiredFlow: false });
  });

  it('ignores a redelivery of the answer that completed the flow', () => {
    startFlow({ db }, user, { kind: 'categoryAdd', ledgerId }, T);
    completeFlow({ db }, user, 'tg:1:9');

    expect(route('tg:1:9', at(MIN))).toEqual({ kind: 'redelivered' });
    expect(route('tg:1:10', at(MIN))).toEqual({ kind: 'free', expiredFlow: false });
  });

  it('is free text after a cancel', () => {
    startFlow({ db }, user, { kind: 'categoryAdd', ledgerId }, T);
    expect(cancelFlow({ db }, user)).toBe(true);

    expect(route('tg:1:1', at(MIN))).toEqual({ kind: 'free', expiredFlow: false });
  });
});
