import { beforeEach, describe, expect, it } from 'vitest';
import { saveChatImport } from '../db/chatImports.js';
import { openDatabase, type Db } from '../db/connection.js';
import { insertLedger, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { provisionUser } from '../services/provisionUser.js';
import { chatImportSweep } from './chatImportSweep.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const EXPIRES = new Date('2026-10-02T08:00:00Z');
const LEDGER = '30000000-0000-4000-8000-000000000001' as LedgerId;

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
  insertLedger(db, {
    id: LEDGER,
    kind: 'shared',
    name: 'Семья',
    defaultCurrency: 'RSD',
    timezone: 'Europe/Belgrade',
    ownerUserId: user.id,
    createdAt: NOW,
  });
  saveChatImport(db, {
    userId: user.id,
    ledgerId: LEDGER,
    chatId: '-1001234567890',
    nonce: 'abc123',
    payload: '{}',
    noticeMessageId: null,
    expiresAt: EXPIRES,
  });
});

const rows = () => db.prepare('SELECT COUNT(*) FROM chat_imports').pluck().get();

describe('chatImportSweep', () => {
  it('is due at the row’s expiry and not a millisecond before', () => {
    const sweep = chatImportSweep({ db, logger: createLogger('silent') });

    expect(sweep.due(new Date(EXPIRES.getTime() - 1))).toEqual([]);
    expect(sweep.due(EXPIRES)).toEqual([user.id]);
  });

  it('deletes the expired row', async () => {
    const sweep = chatImportSweep({ db, logger: createLogger('silent') });

    await sweep.fire(user.id, EXPIRES);

    expect(rows()).toBe(0);
  });

  it('keeps a row a tap renewed after it was found due', async () => {
    const sweep = chatImportSweep({ db, logger: createLogger('silent') });
    const [due] = sweep.due(EXPIRES);
    if (due === undefined) throw new Error('setup: nothing due');
    db.prepare("UPDATE chat_imports SET expires_at = '2026-10-03T08:00:00.000Z'").run();

    await sweep.fire(due, EXPIRES);

    expect(rows()).toBe(1);
  });
});
