import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { seenNotice } from './notices.js';
import { provisionUser } from './provisionUser.js';

const NOW = new Date('2026-10-06T10:00:00Z');

let db: Db;
let user: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  user = provisionUser(
    { db, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    {
      provider: 'telegram',
      externalId: '1001',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    },
  ).user;
});

describe('seenNotice', () => {
  it('says a notice is new once, then never again', () => {
    expect(seenNotice({ db }, user, 'export_plaintext', NOW)).toBe(true);
    expect(seenNotice({ db }, user, 'export_plaintext', NOW)).toBe(false);
    expect(seenNotice({ db }, user, 'export_plaintext', NOW)).toBe(false);
  });

  it('decides each notice on its own', () => {
    seenNotice({ db }, user, 'export_plaintext', NOW);

    expect(seenNotice({ db }, user, 'reminder_plaintext', NOW)).toBe(true);
  });
});
