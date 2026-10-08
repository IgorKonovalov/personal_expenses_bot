import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { listMemberNames } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { findUserByIdentity, type User } from '../db/users.js';
import type { ExportedMessage, ExportRead } from '../domain/chatImport/telegramExport.js';
import { createLogger } from '../logger.js';
import { bindGroup } from './groupChats.js';
import {
  cancelChatImport,
  expiredChatImports,
  previewChatImport,
  recordReadyChatImport,
  sweepChatImport,
  type ChatImportDeps,
  type ChatImportPreview,
} from './importChat.js';
import { provisionUser } from './provisionUser.js';

// The bot joined the group at BOUND; the export's id 1234567890 is the supergroup -1001234567890.
const BOUND = new Date('2026-09-15T00:00:00Z');
const CHAT = -1001234567890;
const NOW = new Date('2026-10-01T08:00:00Z');
const A = 1001;
const B = 1002;

const LIST = 'Краска 2000\nкисти 500\nваликов на 800\n3300 дин';

function message(
  id: number,
  at: string,
  sender: number,
  text: string,
  forwarded = false,
): ExportedMessage {
  return {
    id,
    at: new Date(at),
    senderTelegramId: sender,
    senderName: sender === A ? 'A' : 'B',
    text,
    forwarded,
  };
}

// The nine messages of the readMessage table from A and B, a forwarded copy, and one message
// sent after the bot joined.
const MESSAGES: readonly ExportedMessage[] = [
  message(1, '2026-07-01T09:00:00Z', A, LIST),
  message(2, '2026-07-05T09:00:00Z', B, LIST.replace('3300 дин', '3400 дин')),
  message(3, '2026-07-20T22:30:00Z', A, 'Чайник 3200'),
  message(4, '2026-08-01T09:00:00Z', B, 'ремонт 300€, доставка 4500 динар'),
  message(5, '2026-08-10T09:00:00Z', A, 'Шкаф: 4500'),
  message(6, '2026-08-15T09:00:00Z', B, 'буду в 7'),
  message(7, '2026-08-20T09:00:00Z', A, 'Ира: ремонт 300€'),
  message(8, '2026-09-01T09:00:00Z', B, 'Лампа 1.500'),
  message(9, '2026-09-14T18:00:00Z', A, 'привет всем'),
  message(10, '2026-08-25T09:00:00Z', B, 'Чайник 3200', true),
  message(11, '2026-09-16T09:00:00Z', A, 'Чайник 3200'),
];

function exportOf(
  messages: readonly ExportedMessage[] = MESSAGES,
  chatId = 1234567890,
): Extract<ExportRead, { kind: 'export' }> {
  return { kind: 'export', chatId, name: 'Семья', type: 'private_supergroup', messages };
}

let db: Db;
let deps: ChatImportDeps;
let alice: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, BOUND);
  let n = 0;
  deps = {
    db,
    logger: createLogger('silent'),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
  };
  bindGroup(deps, {
    chatId: CHAT,
    title: 'Семья',
    adder: { telegramId: A, firstName: 'Анна' },
    now: BOUND,
  });
  const found = findUserByIdentity(db, 'telegram', String(A));
  if (found === undefined) throw new Error('setup: no user A');
  alice = found;
});

function preview(user: User = alice, read = exportOf()): ChatImportPreview {
  const result = previewChatImport(deps, { user, export: read, now: NOW });
  if (result.kind !== 'preview') throw new Error(`expected a preview, got ${result.kind}`);
  return result;
}

function rows() {
  return db
    .prepare(
      `SELECT e.amount_minor, e.currency, e.description, e.occurred_on, e.occurred_at,
              e.source_key, i.external_id AS sender
         FROM expenses e JOIN auth_identities i ON i.user_id = e.created_by
        ORDER BY e.rowid`,
    )
    .all();
}

function count(): number {
  return db.prepare('SELECT COUNT(*) FROM expenses').pluck().get() as number;
}

describe('previewChatImport', () => {
  it('counts 7 ready items in 4 messages, 5 to review and 1 without amounts', () => {
    const shown = preview();

    expect(shown).toMatchObject({
      kind: 'preview',
      readyMessages: 4,
      totals: [
        { amountMinor: 1550000, currency: 'RSD' },
        { amountMinor: 30000, currency: 'EUR' },
      ],
      reviewCount: 5,
      noAmountCount: 1,
      alreadyCount: 0,
      skippedCount: 0,
      from: '2026-07-01',
      to: '2026-09-14',
    });
    expect(shown.ready).toHaveLength(7);
    expect(shown.ready.map((item) => item.messageId)).toEqual([1, 1, 1, 3, 4, 4, 5]);
    expect(count()).toBe(0);
  });

  it('finds a basic group bound at -<id>', () => {
    bindGroup(deps, {
      chatId: -4242,
      title: 'Дача',
      adder: { telegramId: A, firstName: 'Анна' },
      now: BOUND,
    });

    expect(preview(alice, exportOf(MESSAGES, 4242)).ledger.name).toBe('Дача');
  });

  it('refuses an unbound chat and a ledger the user isn’t a member of alike', () => {
    const stranger = provisionUser(deps, {
      provider: 'telegram',
      externalId: '3003',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    }).user;

    expect(
      previewChatImport(deps, { user: alice, export: exportOf(MESSAGES, 999), now: NOW }),
    ).toEqual({ kind: 'groupUnknown' });
    expect(previewChatImport(deps, { user: stranger, export: exportOf(), now: NOW })).toEqual({
      kind: 'groupUnknown',
    });
  });
});

describe('recordReadyChatImport', () => {
  it('stores the 7 ready items under their senders, dated by their messages', () => {
    const { nonce } = preview();

    const result = recordReadyChatImport(deps, { user: alice, nonce, now: NOW });

    expect(result).toMatchObject({
      kind: 'recorded',
      count: 7,
      totals: [
        { amountMinor: 1550000, currency: 'RSD' },
        { amountMinor: 30000, currency: 'EUR' },
      ],
    });
    const chat = String(CHAT);
    expect(rows()).toEqual([
      expect.objectContaining({
        amount_minor: 200000,
        description: 'Краска',
        sender: '1001',
        source_key: `tgx:${chat}:1:0`,
      }),
      expect.objectContaining({
        amount_minor: 50000,
        description: 'кисти',
        sender: '1001',
        source_key: `tgx:${chat}:1:1`,
      }),
      expect.objectContaining({
        amount_minor: 80000,
        description: 'валиков',
        sender: '1001',
        source_key: `tgx:${chat}:1:2`,
      }),
      {
        amount_minor: 320000,
        currency: 'RSD',
        description: 'Чайник',
        occurred_on: '2026-07-21',
        occurred_at: '2026-07-20T22:30:00.000Z',
        source_key: `tgx:${chat}:3:0`,
        sender: '1001',
      },
      expect.objectContaining({
        amount_minor: 30000,
        currency: 'EUR',
        description: 'ремонт',
        sender: '1002',
      }),
      expect.objectContaining({
        amount_minor: 450000,
        currency: 'RSD',
        description: 'доставка',
        sender: '1002',
      }),
      expect.objectContaining({ amount_minor: 450000, description: 'Шкаф', sender: '1001' }),
    ]);
  });

  it('makes B, who never started the bot, a member named «B», and keeps A’s name', () => {
    const { nonce, ledger } = preview();

    recordReadyChatImport(deps, { user: alice, nonce, now: NOW });

    const bob = findUserByIdentity(db, 'telegram', String(B));
    if (bob === undefined) throw new Error('B was not provisioned');
    expect(listMemberNames(db, ledger.id)).toEqual(
      new Map([
        [alice.id, 'Анна'],
        [bob.id, 'B'],
      ]),
    );
  });

  it('stores nothing new on a second tap', () => {
    const { nonce } = preview();
    recordReadyChatImport(deps, { user: alice, nonce, now: NOW });

    expect(recordReadyChatImport(deps, { user: alice, nonce, now: NOW })).toMatchObject({
      kind: 'recorded',
      count: 0,
    });
    expect(count()).toBe(7);
  });

  it('previews the same file again as 4 messages already recorded, and records nothing', () => {
    recordReadyChatImport(deps, { user: alice, nonce: preview().nonce, now: NOW });

    const again = preview();

    expect(again).toMatchObject({ readyMessages: 0, alreadyCount: 4, reviewCount: 5 });
    expect(again.ready).toEqual([]);
    expect(
      recordReadyChatImport(deps, { user: alice, nonce: again.nonce, now: NOW }),
    ).toMatchObject({ count: 0 });
    expect(count()).toBe(7);
  });

  it('answers a button of the first upload stale once the file is sent again', () => {
    const first = preview();
    const second = preview();

    expect(second.nonce).not.toBe(first.nonce);
    expect(recordReadyChatImport(deps, { user: alice, nonce: first.nonce, now: NOW })).toEqual({
      kind: 'stale',
    });
    expect(count()).toBe(0);
  });

  it('answers expired past the row’s expiry, and the sweep deletes the row', () => {
    const { nonce } = preview();
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

    expect(expiredChatImports(deps, new Date(later.getTime() - 1))).toEqual([]);
    expect(expiredChatImports(deps, later)).toEqual([alice.id]);
    expect(recordReadyChatImport(deps, { user: alice, nonce, now: later })).toEqual({
      kind: 'expired',
    });
    expect(sweepChatImport(deps, alice.id, later)).toBe(true);
    expect(recordReadyChatImport(deps, { user: alice, nonce, now: NOW })).toEqual({
      kind: 'expired',
    });
    expect(count()).toBe(0);
  });

  it('records nothing after [Отмена]', () => {
    const { nonce } = preview();

    expect(cancelChatImport(deps, { user: alice, nonce, now: NOW })).toBe('cancelled');
    expect(recordReadyChatImport(deps, { user: alice, nonce, now: NOW })).toEqual({
      kind: 'expired',
    });
    expect(count()).toBe(0);
  });
});
