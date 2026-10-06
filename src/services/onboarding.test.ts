import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { insertNoticeSeen } from '../db/notices.js';
import { findOnboarding, setTipsOff, type User } from '../db/users.js';
import { insertTipShown, listTipsShown } from '../db/userTips.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring } from './ledgerKeys.js';
import {
  claimOnboarding,
  firstExpenseInDefaultCurrency,
  isOnboarded,
  pendingOnboarding,
  replayOnboarding,
  setupCheckView,
  setupView,
} from './onboarding.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense } from './recordExpense.js';

const NOW = new Date('2026-10-01T12:05:00Z');

let db: Db;
let n: number;

function deps() {
  return {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
  };
}

function provision(externalId: string): User {
  return provisionUser(deps(), {
    provider: 'telegram',
    externalId,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  n = 0;
});

describe('onboarding', () => {
  it('claims a new user once: the first call sets onboarded_at, the second does nothing', () => {
    const user = provision('1001');
    expect(isOnboarded(deps(), user)).toBe(false);

    expect(claimOnboarding(deps(), user, NOW)).toBe(true);
    expect(claimOnboarding(deps(), user, new Date('2026-10-02T00:00:00Z'))).toBe(false);

    expect(isOnboarded(deps(), user)).toBe(true);
    expect(findOnboarding(db, user.id).onboardedAt).toEqual(NOW);
  });

  it("replays: deletes the user's tips and switches tips on, leaving others' tips and notices", () => {
    const alice = provision('1001');
    const bob = provision('1002');
    insertTipShown(db, alice.id, 'tipFirstExpense', NOW);
    insertTipShown(db, alice.id, 'tipOther', NOW);
    insertTipShown(db, bob.id, 'tipFirstExpense', NOW);
    insertNoticeSeen(db, alice.id, 'stray_help', NOW);
    setTipsOff(db, alice.id, true);

    replayOnboarding(deps(), alice);

    expect(listTipsShown(db, alice.id)).toEqual([]);
    expect(listTipsShown(db, bob.id)).toEqual([{ tip: 'tipFirstExpense', shownAt: NOW }]);
    expect(findOnboarding(db, alice.id).tipsOff).toBe(false);
    expect(
      db.prepare('SELECT notice FROM user_notices WHERE user_id = ?').pluck().all(alice.id),
    ).toEqual(['stray_help']);
  });

  it("reads the setup check's local time in the user's zone", () => {
    const user = provision('1001');

    // CEST is UTC+2 until 2026-10-25.
    expect(setupCheckView(deps(), user, NOW)).toEqual({
      timezone: 'Europe/Belgrade',
      currency: 'RSD',
      localTime: '14:05',
    });
    expect(setupView(deps(), { ...user, timezone: 'Europe/Moscow' })).toEqual({
      timezone: 'Europe/Moscow',
      currency: 'RSD',
    });
  });

  it('finds a never-onboarded user without provisioning anyone', () => {
    const user = provision('1001');

    expect(pendingOnboarding(deps(), 1001)).toEqual(user);
    expect(pendingOnboarding(deps(), 1002)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1);

    claimOnboarding(deps(), user, NOW);
    expect(pendingOnboarding(deps(), 1001)).toBeUndefined();
  });

  it("says whether the user's first expense in the active ledger is in its default currency", () => {
    const record = (user: User, text: string, sourceKey: string) =>
      recordExpense(
        { ...deps(), keys: createLedgerKeyring(() => NOW) },
        { user, text, sourceKey, occurredAt: NOW, now: NOW },
      );
    const rsd = provision('1001');
    expect(firstExpenseInDefaultCurrency(deps(), rsd)).toBe(false);
    record(rsd, '450 кофе', 'tg:1:1');
    expect(firstExpenseInDefaultCurrency(deps(), rsd)).toBe(true);

    const eur = provision('1002');
    record(eur, '12,50 EUR такси', 'tg:2:1');
    expect(firstExpenseInDefaultCurrency(deps(), eur)).toBe(false);
  });
});
