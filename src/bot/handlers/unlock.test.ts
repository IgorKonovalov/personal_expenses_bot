import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/connection.js';
import { runMigrations } from '../../db/migrate.js';
import { formatMoney } from '../../domain/money.js';
import { createLogger } from '../../logger.js';
import { createLedgerKeyring } from '../../services/ledgerKeys.js';
import { createBot } from '../bot.js';
import { RECOVERY_SAVED, SETTINGS_ENCRYPTION } from '../callbackData.js';
import { messages } from '../messages.js';
import {
  ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  textUpdate,
  type ApiCall,
} from '../testHarness.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const PASSPHRASE = 'correct horse 42';

// The harness bot, but sendMessage answers with a real message, so screens get an anchor.
function sealedBot() {
  const db = openDatabase(':memory:');
  runMigrations(db, NOW);
  const logLines: string[] = [];
  let ids = 0;
  let messageId = 100;
  const bot = createBot({
    token: '123456:test-token',
    allowedTelegramIds: new Set([ALLOWED_ID]),
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    db,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    now: () => NOW,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    keys: createLedgerKeyring(),
    botInfo: createTestBot().bot.botInfo,
  });
  const calls: ApiCall[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    const chat = { id: (payload as { chat_id?: number }).chat_id, type: 'private' };
    const result =
      method === 'sendMessage' ? { message_id: ++messageId, date: 0, chat, text: '' } : true;
    return Promise.resolve({ ok: true, result: result as never });
  });
  let updateId = 0;
  const say = (text: string, id: number) =>
    bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId: id, text, date: NOW }));
  const tap = (data: string, id: number) =>
    bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId: id }));
  const sent = () =>
    calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => (call.payload as { text: string }).text);
  const deleted = () =>
    calls
      .filter((call) => call.method === 'deleteMessage')
      .map((call) => (call.payload as { message_id: number }).message_id);
  return { db, calls, logLines, say, tap, sent, deleted };
}

describe('a sealed personal ledger in the bot', () => {
  it('records sealed, answers /today locked, and totals 1650 after /unlock', async () => {
    const { db, calls, say, tap, sent, deleted } = sealedBot();

    await say('/settings', 1);
    await tap(SETTINGS_ENCRYPTION, 101);
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: { message_id: 101, text: messages.encryptionEnablePrompt },
    });

    calls.length = 0;
    await say(PASSPHRASE, 2);
    // The passphrase message is deleted first, then the recovery code arrives on its own.
    expect(calls[0]).toEqual({
      method: 'deleteMessage',
      payload: { chat_id: ALLOWED_ID, message_id: 2 },
    });
    const codeMessage = calls[1];
    expect(codeMessage?.method).toBe('sendMessage');
    expect((codeMessage?.payload as { text: string }).text).toMatch(
      /<code>[A-Z2-7]{4}(-[A-Z2-7]{4}){7}<\/code>/,
    );
    expect((codeMessage?.payload as { reply_markup: unknown }).reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Сохранил', callback_data: RECOVERY_SAVED }]],
    });
    expect(calls[2]).toMatchObject({
      method: 'editMessageText',
      payload: { message_id: 101, text: messages.encryptionScreen('locked') },
    });

    // [Сохранил] deletes the code message (id 102).
    calls.length = 0;
    await tap(RECOVERY_SAVED, 102);
    expect(deleted()).toEqual([102]);

    await say('450 кофе', 3);
    await say('1200 такси', 4);
    expect(
      db
        .prepare('SELECT amount_minor, description, sealed IS NOT NULL AS sealed FROM expenses')
        .all(),
    ).toEqual([
      { amount_minor: null, description: null, sealed: 1 },
      { amount_minor: null, description: null, sealed: 1 },
    ]);
    const bytes = db.serialize();
    expect(bytes.includes(Buffer.from('кофе', 'utf8'))).toBe(false);
    expect(bytes.includes(Buffer.from('такси', 'utf8'))).toBe(false);

    calls.length = 0;
    await say('/today', 5);
    expect(sent()).toEqual([messages.ledgerLocked]);

    calls.length = 0;
    await say('/unlock', 6);
    expect(sent()).toEqual([messages.unlockPrompt]);
    calls.length = 0;
    await say(PASSPHRASE, 7);
    expect(deleted()).toEqual([7]);
    expect(sent()).toEqual([messages.unlocked]);

    calls.length = 0;
    await say('/today', 8);
    const [today] = sent();
    expect(today).toContain(formatMoney({ amountMinor: 165000, currency: 'RSD' }));
  });

  it('a wrong passphrase is deleted, refused, and leaves the ledger locked', async () => {
    const { calls, say, tap, sent, deleted } = sealedBot();
    await say('/settings', 1);
    await tap(SETTINGS_ENCRYPTION, 101);
    await say(PASSPHRASE, 2);
    await say('450 кофе', 3);

    calls.length = 0;
    await say('/unlock', 4);
    await say(`${PASSPHRASE}!`, 5);
    expect(deleted()).toEqual([5]);
    expect(sent()).toEqual([messages.unlockPrompt, messages.wrongPassphrase]);

    calls.length = 0;
    await say('/today', 6);
    expect(sent()).toEqual([messages.ledgerLocked]);
  });

  it('re-asks a too-short passphrase in the anchor, deleting it too', async () => {
    const { db, calls, say, tap, deleted } = sealedBot();
    await say('/settings', 1);
    await tap(SETTINGS_ENCRYPTION, 101);

    calls.length = 0;
    await say('123456789', 2);
    expect(deleted()).toEqual([2]);
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: {
        message_id: 101,
        text: `${messages.passphraseTooShort}\n\n${messages.encryptionEnablePrompt}`,
      },
    });
    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(0);
  });
});
