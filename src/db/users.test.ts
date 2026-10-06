import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';
import {
  findOnboarding,
  findPushOn,
  findTidyChat,
  insertIdentity,
  insertUser,
  listPushRecipients,
  markOnboarded,
  setPushOn,
  setTidyChat,
  setTipsOff,
  setUserBlocked,
  updateUserTimezone,
  type UserId,
} from './users.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const USER = 'user-a' as UserId;
const OTHER = 'user-b' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertUser(db, { id: OTHER, timezone: 'Europe/Belgrade', createdAt: NOW });
});

function timezoneOf(id: UserId): unknown {
  return db.prepare('SELECT timezone FROM users WHERE id = ?').pluck().get(id);
}

describe('updateUserTimezone', () => {
  it('stores the new zone for that user only and reports the write', () => {
    expect(updateUserTimezone(db, USER, 'Europe/Moscow')).toBe(true);
    expect(timezoneOf(USER)).toBe('Europe/Moscow');
    expect(timezoneOf(OTHER)).toBe('Europe/Belgrade');
  });

  it('writes nothing when the zone is already the stored one', () => {
    expect(updateUserTimezone(db, USER, 'Europe/Belgrade')).toBe(false);
    expect(timezoneOf(USER)).toBe('Europe/Belgrade');
  });
});

describe('onboarding state', () => {
  it('starts not onboarded with tips on', () => {
    expect(findOnboarding(db, USER)).toEqual({ onboardedAt: null, tipsOff: false });
  });

  it('marks a user onboarded once, keeping the first instant', () => {
    const later = new Date('2026-10-01T10:00:00Z');

    expect(markOnboarded(db, USER, NOW)).toBe(true);
    expect(markOnboarded(db, USER, later)).toBe(false);

    expect(findOnboarding(db, USER).onboardedAt).toEqual(NOW);
    expect(findOnboarding(db, OTHER).onboardedAt).toBeNull();
  });

  it('sets the tips switch and reports whether it changed', () => {
    expect(setTipsOff(db, USER, true)).toBe(true);
    expect(setTipsOff(db, USER, true)).toBe(false);
    expect(findOnboarding(db, USER).tipsOff).toBe(true);
    expect(findOnboarding(db, OTHER).tipsOff).toBe(false);

    expect(setTipsOff(db, USER, false)).toBe(true);
    expect(findOnboarding(db, USER).tipsOff).toBe(false);
  });
});

describe('migration 0022: onboarding', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('marks a user present before it onboarded, and leaves a later user not onboarded', () => {
    const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const file of readdirSync(migrations).filter((f) => f < '0022')) {
      copyFileSync(join(migrations, file), join(dir, file));
    }
    const old = openDatabase(':memory:');
    runMigrations(old, NOW, dir);
    insertUser(old, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });

    runMigrations(old, NOW);
    insertUser(old, { id: OTHER, timezone: 'Europe/Belgrade', createdAt: NOW });

    expect(findOnboarding(old, USER).onboardedAt).toBeInstanceOf(Date);
    expect(findOnboarding(old, USER).tipsOff).toBe(false);
    expect(findOnboarding(old, OTHER)).toEqual({ onboardedAt: null, tipsOff: false });
  });
});

describe('tidy chat switch', () => {
  it('starts off, and sets the switch for that user only, reporting whether it changed', () => {
    expect(findTidyChat(db, USER)).toBe(false);

    expect(setTidyChat(db, USER, true)).toBe(true);
    expect(setTidyChat(db, USER, true)).toBe(false);
    expect(findTidyChat(db, USER)).toBe(true);
    expect(findTidyChat(db, OTHER)).toBe(false);

    expect(setTidyChat(db, USER, false)).toBe(true);
    expect(findTidyChat(db, USER)).toBe(false);
  });
});

describe('summary push switches', () => {
  function identify(id: UserId, telegramId: string) {
    insertIdentity(db, { provider: 'telegram', externalId: telegramId, userId: id });
  }

  it('starts with the monthly push on and the weekly one off', () => {
    expect(findPushOn(db, USER, 'monthly')).toBe(true);
    expect(findPushOn(db, USER, 'weekly')).toBe(false);
  });

  it('sets one switch for that user only, reporting whether it changed', () => {
    expect(setPushOn(db, USER, 'monthly', false)).toBe(true);
    expect(setPushOn(db, USER, 'monthly', false)).toBe(false);
    expect(findPushOn(db, USER, 'monthly')).toBe(false);
    expect(findPushOn(db, USER, 'weekly')).toBe(false);
    expect(findPushOn(db, OTHER, 'monthly')).toBe(true);

    expect(setPushOn(db, USER, 'weekly', true)).toBe(true);
    expect(findPushOn(db, USER, 'weekly')).toBe(true);
  });

  it('lists the users with a push on and a Telegram identity, not blocked or deleted', () => {
    identify(USER, '1001');
    identify(OTHER, '1002');
    insertUser(db, { id: 'user-c' as UserId, timezone: 'Europe/Moscow', createdAt: NOW });
    identify('user-c' as UserId, '1003');
    insertUser(db, { id: 'user-d' as UserId, timezone: 'Europe/Moscow', createdAt: NOW });
    setPushOn(db, OTHER, 'monthly', false);
    setUserBlocked(db, 'user-c' as UserId, NOW);

    expect(listPushRecipients(db)).toEqual([
      {
        user: { id: USER, timezone: 'Europe/Belgrade', activeLedgerId: null },
        telegramId: 1001,
        monthly: true,
        weekly: false,
      },
    ]);

    setPushOn(db, OTHER, 'weekly', true);
    expect(listPushRecipients(db).map((r) => [r.user.id, r.monthly, r.weekly])).toEqual([
      [USER, true, false],
      [OTHER, false, true],
    ]);
  });
});

describe('migration 0024: summary pushes', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('turns the monthly push on and leaves the weekly one off for a user present before it', () => {
    const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const file of readdirSync(migrations).filter((f) => f < '0024')) {
      copyFileSync(join(migrations, file), join(dir, file));
    }
    const old = openDatabase(':memory:');
    runMigrations(old, NOW, dir);
    insertUser(old, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });

    expect(runMigrations(old, NOW)).toContain('0024');

    expect(findPushOn(old, USER, 'monthly')).toBe(true);
    expect(findPushOn(old, USER, 'weekly')).toBe(false);
  });
});

describe('migration 0023: tidy chat', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('leaves a user present before it at tidy_chat = 0', () => {
    const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const file of readdirSync(migrations).filter((f) => f < '0023')) {
      copyFileSync(join(migrations, file), join(dir, file));
    }
    const old = openDatabase(':memory:');
    runMigrations(old, NOW, dir);
    insertUser(old, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });

    expect(runMigrations(old, NOW)).toContain('0023');

    expect(old.prepare('SELECT tidy_chat FROM users WHERE id = ?').pluck().get(USER)).toBe(0);
    expect(findTidyChat(old, USER)).toBe(false);
  });
});
