import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/connection.js';
import type { ExpenseId } from '../../db/expenses.js';
import { runMigrations } from '../../db/migrate.js';
import { formatMoney } from '../../domain/money.js';
import { buildRsUrl } from '../../domain/receipts/testing/buildRsVl.js';
import { createLogger } from '../../logger.js';
import { createLedgerKeyring } from '../../services/ledgerKeys.js';
import { createBot } from '../bot.js';
import {
  RECOVERY_SAVED,
  SETTINGS_ENCRYPTION,
  SETTINGS_PASSPHRASE,
  categoryPickerData,
  editExpenseData,
  showExpenseData,
  undoExpenseData,
} from '../callbackData.js';
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
    // The enable confirmation names the backups taken before the switch.
    expect((codeMessage?.payload as { text: string }).text).toContain(
      'Резервные копии, сделанные до сегодняшнего дня, хранят их незашифрованными',
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

describe('every read path of a locked sealed ledger', () => {
  async function lockedLedgerWithCoffee() {
    const harness = sealedBot();
    await harness.say('/settings', 1);
    await harness.tap(SETTINGS_ENCRYPTION, 101);
    await harness.say(PASSPHRASE, 2);
    await harness.say('450 кофе', 3);
    const expenseId = harness.db.prepare('SELECT id FROM expenses').pluck().get() as ExpenseId;
    harness.calls.length = 0;
    return { ...harness, expenseId };
  }

  const toasts = (calls: readonly ApiCall[]) =>
    calls
      .filter((call) => call.method === 'answerCallbackQuery')
      .map((call) => (call.payload as { text?: string }).text);

  it('answers /week, /month and /budget with the locked message', async () => {
    const { calls, say, sent } = await lockedLedgerWithCoffee();

    await say('/week', 10);
    await say('/month', 11);
    await say('/budget', 12);

    expect(sent()).toEqual([messages.ledgerLocked, messages.ledgerLocked, messages.ledgerLocked]);
    expect(sent()).not.toContain(messages.genericError);
    expect(calls.filter((call) => call.method === 'editMessageText')).toEqual([]);
  });

  it('answers every tap on an existing card with the locked toast, changing nothing', async () => {
    const { db, calls, tap, expenseId } = await lockedLedgerWithCoffee();
    const before = db.prepare('SELECT * FROM expenses').get();

    for (const data of [
      categoryPickerData(expenseId),
      editExpenseData(expenseId),
      undoExpenseData(expenseId),
      showExpenseData(expenseId),
    ]) {
      await tap(data, 102);
    }

    expect(toasts(calls)).toEqual(Array<string>(4).fill(messages.ledgerLockedToast));
    expect(calls.filter((call) => call.method !== 'answerCallbackQuery')).toEqual([]);
    expect(db.prepare('SELECT * FROM expenses').get()).toEqual(before);
  });

  it('refuses a receipt link with its own message, recording nothing', async () => {
    const { db, say, sent } = await lockedLedgerWithCoffee();
    const counts = () =>
      db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM expenses) AS expenses, (SELECT COUNT(*) FROM receipts) AS receipts',
        )
        .get();
    const before = counts();

    await say(buildRsUrl(), 13);

    expect(sent()).toEqual([messages.receiptSealedLedger]);
    expect(counts()).toEqual(before);
  });
});

describe('/recover and the passphrase change in the bot', () => {
  async function enabled() {
    const harness = sealedBot();
    await harness.say('/settings', 1);
    await harness.tap(SETTINGS_ENCRYPTION, 101);
    harness.calls.length = 0;
    await harness.say(PASSPHRASE, 2);
    const [codeText] = harness.sent();
    const code = /<code>([A-Z2-7-]+)<\/code>/.exec(codeText ?? '')?.[1];
    if (code === undefined) throw new Error('setup: no recovery code shown');
    harness.calls.length = 0;
    return { ...harness, code };
  }

  it('deletes the code and the new passphrase, and leaves the ledger open', async () => {
    const { calls, say, sent, deleted, code } = await enabled();

    await say('/recover', 10);
    await say(code, 11);
    await say('new passphrase Y', 12);
    expect(deleted()).toEqual([11, 12]);
    expect(sent()).toEqual([
      messages.recoverPrompt,
      messages.recoveredPrompt,
      messages.passphraseChanged,
    ]);

    // The code unlocked the ledger. Which passphrase opens it next: ledgerKeys.test.ts.
    calls.length = 0;
    await say('/unlock', 13);
    expect(sent()).toEqual([messages.alreadyUnlocked]);
  });

  it('changes the passphrase from the unlocked encryption screen, deleting it', async () => {
    const { calls, say, tap, deleted, sent } = await enabled();
    await say('/unlock', 10);
    await say(PASSPHRASE, 11);

    await say('/settings', 12);
    await tap(SETTINGS_ENCRYPTION, 105);
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: {
        message_id: 105,
        text: messages.encryptionScreen('unlocked'),
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Сменить пароль', callback_data: SETTINGS_PASSPHRASE }],
            [{ text: messages.backButton, callback_data: 'set:open' }],
          ],
        },
      },
    });
    await tap(SETTINGS_PASSPHRASE, 105);
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: { message_id: 105, text: messages.changePassphrasePrompt },
    });

    calls.length = 0;
    await say('another passphrase', 13);
    expect(deleted()).toEqual([13]);
    expect(sent()).toEqual([messages.passphraseChanged]);
  });

  it('a wrong code is deleted and refused, and the ledger stays locked', async () => {
    const { say, sent, deleted } = await enabled();

    await say('/recover', 10);
    await say('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', 11);
    await say('/today', 12);

    expect(deleted()).toEqual([11]);
    expect(sent()).toEqual([
      messages.recoverPrompt,
      messages.wrongRecoveryCode,
      messages.ledgerLocked,
    ]);
  });
});
