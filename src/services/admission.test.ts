import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import {
  accessOf,
  admitTelegramIds,
  createInvite,
  isAdmitted,
  redeemInvite,
  type AdmissionDeps,
} from './admission.js';
import { provisionUser } from './provisionUser.js';

const NOW = new Date('2026-10-01T10:00:00Z');
const ADMIN = 999;

let db: Db;
let deps: AdmissionDeps;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    adminTelegramId: ADMIN,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
  };
});

function admittedAtOf(telegramId: number): unknown {
  return db
    .prepare(
      `SELECT u.admitted_at FROM auth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.external_id = ?`,
    )
    .pluck()
    .get(String(telegramId));
}

describe('admitTelegramIds', () => {
  it('admits every listed id, and a second boot changes no admitted_at', () => {
    expect(admitTelegramIds(deps, [ADMIN, 111, 222], NOW)).toBe(3);
    expect(admittedAtOf(111)).toBe('2026-10-01T10:00:00.000Z');
    expect(admittedAtOf(222)).toBe('2026-10-01T10:00:00.000Z');
    expect(isAdmitted(deps, 111)).toBe(true);
    expect(isAdmitted(deps, 222)).toBe(true);

    const later = new Date('2026-10-02T10:00:00Z');
    expect(admitTelegramIds(deps, [ADMIN, 111, 222], later)).toBe(0);
    expect(admittedAtOf(111)).toBe('2026-10-01T10:00:00.000Z');
    expect(admittedAtOf(222)).toBe('2026-10-01T10:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(3);
  });
});

describe('accessOf', () => {
  it('admits the admin with no row, and calls an unknown id a stranger', () => {
    expect(accessOf(deps, ADMIN)).toBe('admitted');
    expect(accessOf(deps, 111)).toBe('stranger');
  });

  it('lets blocked_at override admission', () => {
    admitTelegramIds(deps, [111], NOW);
    db.prepare('UPDATE users SET blocked_at = ?').run(NOW.toISOString());
    expect(accessOf(deps, 111)).toBe('blocked');
    expect(isAdmitted(deps, 111)).toBe(false);
  });
});

describe('redeemInvite', () => {
  it('refuses at created_at + 24h exactly and accepts 1 ms before, for a 1-day code', () => {
    const invite = createInvite(deps, { maxUses: 5, days: 1, now: NOW });
    const expiry = NOW.getTime() + 24 * 60 * 60 * 1000;

    expect(
      redeemInvite(deps, { code: invite.code, telegramId: 111, now: new Date(expiry) }).kind,
    ).toBe('invalid');
    expect(accessOf(deps, 111)).toBe('stranger');
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0);

    expect(
      redeemInvite(deps, { code: invite.code, telegramId: 111, now: new Date(expiry - 1) }).kind,
    ).toBe('admitted');
    expect(accessOf(deps, 111)).toBe('admitted');
  });

  it('refuses past max_uses, a revoked code and an unknown code', () => {
    const invite = createInvite(deps, { maxUses: 1, days: 14, now: NOW });
    expect(redeemInvite(deps, { code: invite.code, telegramId: 111, now: NOW }).kind).toBe(
      'admitted',
    );
    expect(redeemInvite(deps, { code: invite.code, telegramId: 222, now: NOW }).kind).toBe(
      'invalid',
    );

    const revoked = createInvite(deps, { maxUses: 5, days: 14, now: NOW });
    db.prepare('UPDATE invite_codes SET revoked_at = ? WHERE code = ?').run(
      NOW.toISOString(),
      revoked.code,
    );
    expect(redeemInvite(deps, { code: revoked.code, telegramId: 333, now: NOW }).kind).toBe(
      'invalid',
    );
    expect(redeemInvite(deps, { code: 'AAAAAAAAAAA', telegramId: 444, now: NOW }).kind).toBe(
      'invalid',
    );
  });

  it('admits a user a group already provisioned, without a second user row', () => {
    // Provisioned but not admitted, as a group sender is.
    provisionUser(deps, {
      provider: 'telegram',
      externalId: '111',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    });
    expect(accessOf(deps, 111)).toBe('stranger');
    const invite = createInvite(deps, { maxUses: 5, days: 14, now: NOW });
    expect(redeemInvite(deps, { code: invite.code, telegramId: 111, now: NOW }).kind).toBe(
      'admitted',
    );
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1);
  });
});
