import { describe, expect, it } from 'vitest';
import type { ExpenseId } from '../db/expenses.js';
import { assertCallbackData, undoExpenseData } from './callbackData.js';
import { messages } from './messages.js';
import {
  ALLOWED_ID,
  SECOND_ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  logContent,
  textUpdate,
} from './testHarness.js';

const EXPENSE_ID = '00000000-0000-4000-8000-000000000003';
const undoKeyboard = {
  inline_keyboard: [[{ text: messages.undoButton, callback_data: `exp:undo:${EXPENSE_ID}` }]],
};

describe('error boundary', () => {
  it('replies with one generic apology and logs the update id without the message text', async () => {
    const { bot, calls, logLines } = createTestBot({ logLevel: 'info' });
    bot.on('message:location', () => {
      throw new Error('handler exploded');
    });

    await bot.handleUpdate({
      update_id: 555,
      message: {
        message_id: 7,
        date: 1_790_000_000,
        chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
        from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
        location: { latitude: 0, longitude: 0 },
        caption: '450 synthetic-coffee',
      },
    });

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.genericError } },
    ]);
    const errorLines = logLines.filter((line) => line.includes('handler failed'));
    expect(errorLines).toHaveLength(1);
    expect(JSON.parse(errorLines[0] ?? '{}')).toMatchObject({ updateId: 555, level: 50 });
    for (const line of logLines) {
      expect(logContent(line)).not.toContain('synthetic-coffee');
      expect(logContent(line)).not.toContain('450');
    }
  });
});

describe('recording an expense', () => {
  it('confirms 450 coffee naming the ledger, with an Undo button', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Записано в «Личные расходы»: 450.00 RSD — coffee',
          reply_markup: undoKeyboard,
        },
      },
    ]);
  });

  it('re-sends the same confirmation for a redelivered message and stores one row', async () => {
    const { bot, calls, db } = createTestBot();
    const update = textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' });

    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('records nothing for 1.200 lunch and offers both readings and how to resend', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '1.200 lunch' }));

    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 0 });
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text:
            'Сумму можно понять по-разному: 1 200.00 RSD или 1.20 RSD. Ничего не записано. ' +
            'Отправьте ещё раз так: «1200 lunch» или «1.2 lunch».',
        },
      },
    ]);
  });

  it('answers non-expense text with the help hint', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: 'coffee 450' }));

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help } },
    ]);
  });

  it('logs no amount or description at info', async () => {
    const { bot, logLines } = createTestBot({ logLevel: 'info' });

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' }));

    expect(logLines.some((line) => line.includes('expense recorded'))).toBe(true);
    for (const line of logLines) {
      expect(logContent(line)).not.toContain('450');
      expect(logContent(line)).not.toContain('coffee');
    }
  });
});

describe('undo', () => {
  async function recorded() {
    const harness = createTestBot();
    await harness.bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' }));
    harness.calls.length = 0;
    return harness;
  }

  it('soft-deletes, confirms, and answers a second tap with already undone', async () => {
    const { bot, calls, db } = await recorded();
    const data = `exp:undo:${EXPENSE_ID}`;

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data }));
    const deletedAt = db.prepare('SELECT deleted_at FROM expenses').pluck().get();
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data }));

    expect(deletedAt).toBe('2026-09-29T22:10:00.000Z');
    expect(db.prepare('SELECT deleted_at FROM expenses').pluck().get()).toBe(deletedAt);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: messages.undoneToast },
      },
      {
        method: 'editMessageText',
        payload: {
          chat_id: ALLOWED_ID,
          message_id: 2,
          text: 'Отменено в «Личные расходы»: 450.00 RSD — coffee',
        },
      },
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-3', text: messages.alreadyUndone },
      },
    ]);
  });

  it("refuses a tap from a user who isn't the creator", async () => {
    const { bot, calls, db } = await recorded();

    await bot.handleUpdate(
      callbackUpdate({ updateId: 2, fromId: SECOND_ALLOWED_ID, data: `exp:undo:${EXPENSE_ID}` }),
    );

    expect(db.prepare('SELECT deleted_at FROM expenses').pluck().get()).toBeNull();
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: messages.undoForbidden },
      },
    ]);
  });

  it('acknowledges an unknown button silently', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: 'old:thing:1' }));

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-1' } },
    ]);
  });
});

describe('callback data', () => {
  it('is exp:undo:<uuid>, 45 bytes', () => {
    const data = undoExpenseData(EXPENSE_ID as ExpenseId);
    expect(data).toBe(`exp:undo:${EXPENSE_ID}`);
    expect(Buffer.byteLength(data, 'utf8')).toBe(45);
  });

  it('asserts the 64-byte limit', () => {
    expect(assertCallbackData('x'.repeat(64))).toBe('x'.repeat(64));
    expect(() => assertCallbackData('x'.repeat(65))).toThrow(/65 bytes/);
    expect(() => assertCallbackData('я'.repeat(33))).toThrow(/66 bytes/);
  });
});
