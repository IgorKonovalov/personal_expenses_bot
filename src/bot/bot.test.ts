import type { Bot } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/connection.js';
import type { CategoryId } from '../db/categories.js';
import type { ExpenseId } from '../db/expenses.js';
import { CATEGORY_PRESETS } from '../domain/categoryPresets.js';
import { toCurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { createLogger } from '../logger.js';
import { registerCommands } from './bot.js';
import {
  assertCallbackData,
  categoryPageData,
  categoryPickerData,
  restoreExpenseData,
  setCategoryData,
  showExpenseData,
  undoExpenseData,
} from './callbackData.js';
import { messages } from './messages.js';
import { editHtml, html, htmlParseMode } from './render/html.js';
import {
  ALLOWED_ID,
  SECOND_ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  logContent,
  textUpdate,
  type ApiCall,
} from './testHarness.js';

function silentLogger() {
  return createLogger('silent');
}

const EXPENSE_ID = '00000000-0000-4000-8000-000000000003';
// The recorded card's keyboard: [Категория] above [Удалить].
const undoKeyboard = {
  inline_keyboard: [
    [{ text: 'Категория', callback_data: `exp:cat:${EXPENSE_ID}` }],
    [{ text: messages.undoButton, callback_data: `exp:undo:${EXPENSE_ID}` }],
  ],
};

describe('error boundary', () => {
  it('replies with one generic apology and logs the update id without the message text', async () => {
    const { bot, calls, db, logLines } = createTestBot({ logLevel: 'info' });
    // Every handler that records an expense throws on a closed database.
    db.close();

    await bot.handleUpdate(
      textUpdate({ updateId: 555, messageId: 7, text: '450 synthetic-coffee' }),
    );

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: ALLOWED_ID, text: messages.genericError, ...htmlParseMode },
      },
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

const menuKeyboard = {
  keyboard: [[{ text: '📊 Сегодня' }, { text: '❓ Помощь' }]],
  is_persistent: true,
  resize_keyboard: true,
};
const withMenu = { reply_markup: menuKeyboard, ...htmlParseMode };

function expenseCount(db: Db): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM expenses').get();
}

function sentTexts(calls: readonly ApiCall[]): unknown[] {
  return calls.map((call) => (call.payload as { text?: unknown }).text);
}

describe('menu and help', () => {
  const NOW = new Date('2026-09-30T10:00:00Z');

  it('takes its labels from messages.menu', () => {
    expect(messages.menu).toEqual({ today: '📊 Сегодня', help: '❓ Помощь' });
  });

  it('carries the persistent menu on the /start and /help replies', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/help' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: ALLOWED_ID, text: messages.welcome, ...withMenu },
      },
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help, ...withMenu } },
    ]);
  });

  it('seeds the personal ledger categories once across two /start', async () => {
    const { bot, db } = createTestBot();
    const count = () => db.prepare('SELECT COUNT(*) FROM categories').pluck().get();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start' }));
    const first = count();
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/start' }));

    expect(first).toBe(CATEGORY_PRESETS.length);
    expect(count()).toBe(CATEGORY_PRESETS.length);
  });

  it('names the menu buttons in the help text', () => {
    expect(messages.help).toContain('📊 Сегодня');
    expect(messages.help).toContain('❓ Помощь');
  });

  it('answers the 📊 Сегодня label exactly like /today and records nothing', async () => {
    const { bot, calls, db } = createTestBot({ now: NOW });
    await bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '450 coffee', date: NOW }),
    );
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 2, messageId: 11, text: '/today' }));
    await bot.handleUpdate(textUpdate({ updateId: 3, messageId: 12, text: '📊 Сегодня' }));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(sentTexts(calls)[0]).toBe('<b>Сегодня, 30 сентября — «Личные расходы»</b>\n450.00 RSD');
    expect(expenseCount(db)).toEqual({ n: 1 });
  });

  it('answers the ❓ Помощь label exactly like /help', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/help' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '❓ Помощь' }));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it.each(['Сегодня', '📊 Сегодня!'])(
    'treats %j as text for the expense parser, not a menu tap',
    async (text) => {
      const { bot, calls, db } = createTestBot();

      await bot.handleUpdate(textUpdate({ updateId: 1, text }));

      expect(sentTexts(calls)).toEqual([messages.help]);
      expect(expenseCount(db)).toEqual({ n: 0 });
    },
  );

  it('never parses a menu label as an expense, in any currency', () => {
    // currencies.ts exports no roster, so every three-letter code is probed against it.
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const codes = letters.flatMap((a) =>
      letters.flatMap((b) => letters.flatMap((c) => toCurrencyCode(`${a}${b}${c}`) ?? [])),
    );
    expect(codes).toContain('RSD');
    for (const label of Object.values(messages.menu)) {
      for (const currency of codes) {
        expect(['recorded', 'expense', 'ambiguous']).not.toContain(
          parseExpenseText(label, currency).kind,
        );
      }
    }
  });

  it('answers an unknown command with the help reply and records nothing', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/help' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/foo' }));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(expenseCount(db)).toEqual({ n: 0 });
  });
});

describe('input that is not an expense text', () => {
  function messageUpdate(updateId: number, content: Record<string, unknown>): Update {
    return {
      update_id: updateId,
      message: {
        message_id: 50 + updateId,
        date: 1_790_000_000,
        chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
        from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
        ...content,
      },
    };
  }

  function tableCounts(db: Db): unknown {
    return db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM expenses) AS expenses, (SELECT COUNT(*) FROM users) AS users,
                (SELECT COUNT(*) FROM ledgers) AS ledgers`,
      )
      .get();
  }

  it.each([
    ['photo', { photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] }],
    [
      'sticker',
      {
        sticker: {
          file_id: 's',
          file_unique_id: 's',
          type: 'regular',
          width: 1,
          height: 1,
          is_animated: false,
          is_video: false,
        },
      },
    ],
    ['voice', { voice: { file_id: 'v', file_unique_id: 'v', duration: 1 } }],
  ])('answers a %s with the help reply and writes nothing', async (_kind, content) => {
    const { bot, calls, db } = createTestBot();
    const before = tableCounts(db);

    await bot.handleUpdate(messageUpdate(1, content));

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help, ...withMenu } },
    ]);
    expect(tableCounts(db)).toEqual(before);
  });

  function editedUpdate(updateId: number, messageId: number, text: string): Update {
    return {
      update_id: updateId,
      edited_message: {
        message_id: messageId,
        date: 1_790_000_000,
        edit_date: 1_790_000_100,
        chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
        from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
        text,
      },
    };
  }

  it('hints on an edit of a recorded or deleted expense and changes nothing', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, messageId: 11, text: '50 tea' }));
    await bot.handleUpdate(
      callbackUpdate({ updateId: 3, data: `exp:undo:00000000-0000-4000-8000-000000000004` }),
    );
    const rows = db.prepare('SELECT * FROM expenses ORDER BY id').all();
    calls.length = 0;

    await bot.handleUpdate(editedUpdate(4, 10, '500 coffee'));
    await bot.handleUpdate(editedUpdate(5, 11, '60 tea'));

    const hint = {
      method: 'sendMessage',
      payload: { chat_id: ALLOWED_ID, text: messages.editedMessageHint, ...htmlParseMode },
    };
    expect(calls).toEqual([hint, hint]);
    expect(db.prepare('SELECT * FROM expenses ORDER BY id').all()).toEqual(rows);
  });

  it('ignores an edit of any other message and writes nothing', async () => {
    const { bot, calls, db } = createTestBot();
    const before = tableCounts(db);

    await bot.handleUpdate(editedUpdate(1, 10, '450 coffee'));

    expect(calls).toEqual([]);
    expect(tableCounts(db)).toEqual(before);
  });

  it('pins the edited-message hint and the generic error copy', () => {
    expect(messages.editedMessageHint).toBe(
      'Изменение сообщения не меняет запись. Удалите трату кнопкой под подтверждением и ' +
        'отправьте её заново.',
    );
    expect(messages.genericError).toBe(
      'Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не записалась.',
    );
  });
});

describe('command registration at boot', () => {
  it('registers /today and /help with descriptions from messages', async () => {
    const { bot, calls } = createTestBot();

    await registerCommands(bot, silentLogger());

    expect(calls).toEqual([
      {
        method: 'setMyCommands',
        payload: {
          commands: [
            { command: 'today', description: messages.commands[0].description },
            { command: 'help', description: messages.commands[1].description },
          ],
        },
      },
    ]);
  });

  it('logs one warning and returns when setMyCommands fails', async () => {
    const { bot } = createTestBot();
    bot.api.config.use(() => Promise.reject(new Error('network down')));
    const lines: string[] = [];

    await registerCommands(
      bot,
      createLogger('info', { write: (line: string) => void lines.push(line) }),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 40, msg: 'setMyCommands failed' });
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
          text: 'Записано в «Личные расходы»: <b>450.00 RSD</b> — coffee · Кафе и рестораны',
          reply_markup: undoKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('stores markup-like text as typed and escapes it in the HTML confirmation', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '450 <b>кофе</b> & чай' }));

    expect(db.prepare('SELECT description FROM expenses').pluck().get()).toBe('<b>кофе</b> & чай');
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Записано в «Личные расходы»: <b>450.00 RSD</b> — &lt;b&gt;кофе&lt;/b&gt; &amp; чай · Другое',
          reply_markup: undoKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('cuts a long description before escaping, so no entity is split', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: `450 ${'<'.repeat(300)}` }));

    expect(sentTexts(calls)).toEqual([
      `Записано в «Личные расходы»: <b>450.00 RSD</b> — ${'&lt;'.repeat(200)}… · Другое`,
    ]);
  });

  it('stores a 4096-character message whole and confirms it with the description cut', async () => {
    const { bot, calls, db } = createTestBot();
    const description = 'я'.repeat(4092);

    await bot.handleUpdate(textUpdate({ updateId: 1, text: `450 ${description}` }));

    expect(db.prepare('SELECT description FROM expenses').pluck().get()).toBe(description);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: `Записано в «Личные расходы»: <b>450.00 RSD</b> — ${'я'.repeat(200)}… · Другое`,
          reply_markup: undoKeyboard,
          ...htmlParseMode,
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

  it('answers non-expense text with the help hint', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: 'coffee 450' }));

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help, ...withMenu } },
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

const restoreKeyboard = {
  inline_keyboard: [[{ text: messages.restoreButton, callback_data: `exp:restore:${EXPENSE_ID}` }]],
};

describe('expense card: delete and restore', () => {
  // Local 12:00 on 30 September, so /today includes the expense.
  const NOW = new Date('2026-09-30T10:00:00Z');
  const UNDO = `exp:undo:${EXPENSE_ID}`;
  const RESTORE = `exp:restore:${EXPENSE_ID}`;

  async function recorded() {
    const harness = createTestBot({ now: NOW });
    await harness.bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '450 кофе', date: NOW }),
    );
    harness.calls.length = 0;
    return harness;
  }

  async function todayText(bot: Bot, calls: ApiCall[], updateId: number): Promise<unknown> {
    calls.length = 0;
    await bot.handleUpdate(textUpdate({ updateId, messageId: 100 + updateId, text: '/today' }));
    return sentTexts(calls)[0];
  }

  function deletedAt(db: Db): unknown {
    return db.prepare('SELECT deleted_at FROM expenses').pluck().get();
  }

  it('pins the card copy', () => {
    expect({
      undoButton: messages.undoButton,
      undoneToast: messages.undoneToast,
      alreadyUndone: messages.alreadyUndone,
      undoForbidden: messages.undoForbidden,
      restoreButton: messages.restoreButton,
      restoredToast: messages.restoredToast,
      alreadyRestored: messages.alreadyRestored,
    }).toEqual({
      undoButton: 'Удалить',
      undoneToast: 'Трата удалена',
      alreadyUndone: 'Эта трата уже удалена',
      undoForbidden: 'Удалить трату может только тот, кто её записал',
      restoreButton: 'Вернуть',
      restoredToast: 'Трата восстановлена',
      alreadyRestored: 'Трата уже восстановлена',
    });
  });

  it('confirms with one row holding [Удалить]', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 кофе' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны',
          reply_markup: undoKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('deletes into the deleted card with [Вернуть]; a second tap says already deleted', async () => {
    const { bot, calls, db } = await recorded();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: UNDO }));
    const firstDeletedAt = deletedAt(db);
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: UNDO }));

    expect(firstDeletedAt).toBe('2026-09-30T10:00:00.000Z');
    expect(deletedAt(db)).toBe(firstDeletedAt);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: 'Трата удалена' },
      },
      {
        method: 'editMessageText',
        payload: {
          chat_id: ALLOWED_ID,
          message_id: 2,
          text: 'Удалено из «Личные расходы»: <b>450.00 RSD</b> — кофе',
          reply_markup: restoreKeyboard,
          ...htmlParseMode,
        },
      },
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-3', text: 'Эта трата уже удалена' },
      },
    ]);
  });

  it('restores into the confirmation with [Удалить]; a second tap writes nothing', async () => {
    const { bot, calls, db } = await recorded();
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: UNDO }));
    expect(await todayText(bot, calls, 3)).toBe(
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
    );
    calls.length = 0;

    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: RESTORE }));
    expect(deletedAt(db)).toBeNull();
    await bot.handleUpdate(callbackUpdate({ updateId: 5, data: RESTORE }));

    expect(deletedAt(db)).toBeNull();
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-4', text: 'Трата восстановлена' },
      },
      {
        method: 'editMessageText',
        payload: {
          chat_id: ALLOWED_ID,
          message_id: 2,
          text: 'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны',
          reply_markup: undoKeyboard,
          ...htmlParseMode,
        },
      },
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-5', text: 'Трата уже восстановлена' },
      },
    ]);
    expect(await todayText(bot, calls, 6)).toBe(
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\n450.00 RSD',
    );
  });

  it('leaves one deleted row after delete, restore, delete', async () => {
    const { bot, calls, db } = await recorded();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: UNDO }));
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: RESTORE }));
    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: UNDO }));

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE source_key = 'tg:1001:10'").get(),
    ).toEqual({ n: 1 });
    expect(deletedAt(db)).toBe('2026-09-30T10:00:00.000Z');
    expect(await todayText(bot, calls, 5)).toBe(
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
    );
  });

  it('answers a redelivered message whose expense is deleted with the deleted card', async () => {
    const { bot, calls, db } = await recorded();
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: UNDO }));
    const rows = db.prepare('SELECT * FROM expenses').all();
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 кофе', date: NOW }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Удалено из «Личные расходы»: <b>450.00 RSD</b> — кофе',
          reply_markup: restoreKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
    expect(db.prepare('SELECT * FROM expenses').all()).toEqual(rows);
  });

  it("refuses a restore from a user who isn't the creator", async () => {
    const { bot, calls, db } = await recorded();
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: UNDO }));
    calls.length = 0;

    await bot.handleUpdate(
      callbackUpdate({ updateId: 3, fromId: SECOND_ALLOWED_ID, data: RESTORE }),
    );

    expect(deletedAt(db)).toBe('2026-09-30T10:00:00.000Z');
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-3', text: messages.restoreForbidden },
      },
    ]);
  });
});

describe('ambiguous amounts answered with buttons', () => {
  const SENT = new Date('2026-09-29T21:50:00Z');

  // A tap on the question (message 11), which replies to the user's message 10 unless the
  // original is gone.
  function readingTap(
    updateId: number,
    data: string,
    original?: { readonly text: string },
  ): Update {
    const chat = { id: ALLOWED_ID, type: 'private' as const, first_name: 'Test' };
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
        chat_instance: 'test',
        data,
        message: {
          message_id: 11,
          date: 1_790_000_000,
          chat,
          text: 'question',
          ...(original === undefined
            ? {}
            : {
                // grammY types a reply as `Message & { reply_to_message: undefined }`, which no
                // literal satisfies under exactOptionalPropertyTypes.
                reply_to_message: {
                  message_id: 10,
                  date: Math.floor(SENT.getTime() / 1000),
                  chat,
                  from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
                  text: original.text,
                } as unknown as NonNullable<Message['reply_to_message']>,
              }),
        },
      },
    };
  }

  function rows(db: Db): unknown[] {
    return db
      .prepare('SELECT amount_minor, currency, description, source_key, occurred_at FROM expenses')
      .all();
  }

  async function asked(text: string) {
    const harness = createTestBot();
    await harness.bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text, date: SENT }));
    return harness;
  }

  function question(text: string, buttons: { text: string; callback_data: string }[]) {
    return {
      method: 'sendMessage',
      payload: {
        chat_id: ALLOWED_ID,
        text,
        reply_parameters: { message_id: 10 },
        reply_markup: { inline_keyboard: [buttons] },
        ...htmlParseMode,
      },
    };
  }

  function editedIntoCard(text: string) {
    return {
      method: 'editMessageText',
      payload: {
        chat_id: ALLOWED_ID,
        message_id: 11,
        text,
        reply_markup: undoKeyboard,
        ...htmlParseMode,
      },
    };
  }

  it('asks about 1.200 обед with one button per reading, replying to the message', async () => {
    const { calls, db } = await asked('1.200 обед');

    expect(rows(db)).toEqual([]);
    expect(calls).toEqual([
      question('Сумму можно понять по-разному. Ничего не записано — выберите:', [
        { text: '1 200.00 RSD', callback_data: 'amb:t' },
        { text: '1.20 RSD', callback_data: 'amb:d' },
      ]),
    ]);
  });

  it('records the tapped reading under the original message key and edits in the card', async () => {
    const { bot, calls, db } = await asked('1.200 обед');
    calls.length = 0;

    await bot.handleUpdate(readingTap(2, 'amb:t', { text: '1.200 обед' }));

    expect(rows(db)).toEqual([
      {
        amount_minor: 120000,
        currency: 'RSD',
        description: 'обед',
        source_key: 'tg:1001:10',
        occurred_at: '2026-09-29T21:50:00.000Z',
      },
    ]);
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
      editedIntoCard('Записано в «Личные расходы»: <b>1 200.00 RSD</b> — обед · Кафе и рестораны'),
    ]);
  });

  it('records once for a second tap, the other reading, and a redelivered original', async () => {
    const { bot, calls, db } = await asked('1.200 обед');
    await bot.handleUpdate(readingTap(2, 'amb:t', { text: '1.200 обед' }));
    calls.length = 0;

    await bot.handleUpdate(readingTap(3, 'amb:t', { text: '1.200 обед' }));
    await bot.handleUpdate(readingTap(4, 'amb:d', { text: '1.200 обед' }));
    await bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '1.200 обед', date: SENT }),
    );

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE source_key = 'tg:1001:10'").get(),
    ).toEqual({ n: 1 });
    expect(db.prepare('SELECT amount_minor FROM expenses').pluck().get()).toBe(120000);
    const card = 'Записано в «Личные расходы»: <b>1 200.00 RSD</b> — обед · Кафе и рестораны';
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-3' } },
      editedIntoCard(card),
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-4' } },
      editedIntoCard(card),
      {
        method: 'sendMessage',
        payload: { chat_id: ALLOWED_ID, text: card, reply_markup: undoKeyboard, ...htmlParseMode },
      },
    ]);
  });

  it('asks about the one reading of 1.234 обед and records 123400 RSD on a tap', async () => {
    const { bot, calls, db } = await asked('1.234 обед');

    await bot.handleUpdate(readingTap(2, 'amb:t', { text: '1.234 обед' }));

    expect(calls[0]).toEqual(
      question('Ничего не записано. Вы имели в виду 1 234.00 RSD?', [
        { text: '1 234.00 RSD', callback_data: 'amb:t' },
      ]),
    );
    expect(rows(db)).toMatchObject([{ amount_minor: 123400, currency: 'RSD' }]);
  });

  it('asks about the one reading of 1.200 JPY обед and records 1200 JPY on a tap', async () => {
    const { bot, calls, db } = await asked('1.200 JPY обед');

    await bot.handleUpdate(readingTap(2, 'amb:t', { text: '1.200 JPY обед' }));

    expect(calls[0]).toEqual(
      question('Ничего не записано. Вы имели в виду 1 200 JPY?', [
        { text: '1 200 JPY', callback_data: 'amb:t' },
      ]),
    );
    expect(rows(db)).toMatchObject([{ amount_minor: 1200, currency: 'JPY', description: 'обед' }]);
  });

  it('toasts and records nothing when the original message is unavailable', async () => {
    const { bot, calls, db } = await asked('1.200 обед');
    calls.length = 0;

    await bot.handleUpdate(readingTap(2, 'amb:t'));

    expect(rows(db)).toEqual([]);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: {
          callback_query_id: 'cb-2',
          text: 'Исходное сообщение недоступно. Отправьте трату ещё раз.',
        },
      },
    ]);
  });

  it('toasts and records nothing when the re-parse no longer offers the tapped reading', async () => {
    const { bot, calls, db } = await asked('1.234 обед');
    calls.length = 0;

    await bot.handleUpdate(readingTap(2, 'amb:d', { text: '1.234 обед' }));

    expect(rows(db)).toEqual([]);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: messages.ambiguousSourceUnavailable },
      },
    ]);
  });

  it('logs no amount or description at info', async () => {
    const harness = createTestBot({ logLevel: 'info' });
    await harness.bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '1.200 обед', date: SENT }),
    );
    await harness.bot.handleUpdate(readingTap(2, 'amb:t', { text: '1.200 обед' }));
    await harness.bot.handleUpdate(readingTap(3, 'amb:d', { text: '1.200 обед' }));

    expect(harness.logLines.some((line) => line.includes('expense recorded'))).toBe(true);
    for (const line of harness.logLines) {
      const content = logContent(line);
      for (const secret of ['1200', '1.200', '1 200', '120000', 'обед']) {
        expect(content).not.toContain(secret);
      }
    }
  });
});

describe('callback dispatcher', () => {
  it('lets a scope registered after createBot fire', async () => {
    const { bot, calls } = createTestBot();
    const seen: string[] = [];
    bot.callbackQuery(/^zz:/, async (ctx) => {
      seen.push(ctx.callbackQuery.data);
      await ctx.answerCallbackQuery({ text: 'zz' });
    });

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: 'zz:go' }));

    expect(seen).toEqual(['zz:go']);
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-1', text: 'zz' } },
    ]);
  });

  it('answers a callback nothing handles exactly once, silently', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: 'qq:1' }));

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-1' } },
    ]);
  });

  it('answers once and apologises once when a handler answers and then throws', async () => {
    const { bot, calls } = createTestBot();
    bot.callbackQuery(/^zz:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      throw new Error('handler exploded');
    });

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: 'zz:boom' }));

    expect(calls.filter((call) => call.method === 'answerCallbackQuery')).toHaveLength(1);
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-1' } },
      {
        method: 'sendMessage',
        payload: { chat_id: ALLOWED_ID, text: messages.genericError, ...htmlParseMode },
      },
    ]);
  });

  it('treats "message is not modified" from editHtml as success', async () => {
    const { bot, calls } = createTestBot();
    // Telegram's real answer to an edit with the current text and markup.
    const notModified =
      'Bad Request: message is not modified: specified new message content and reply markup ' +
      'are exactly the same as a current content and reply markup of the message';
    bot.api.config.use(async (prev, method, payload, signal) => {
      const result = await prev(method, payload, signal);
      return method === 'editMessageText'
        ? { ok: false, error_code: 400, description: notModified }
        : result;
    });
    let resolved = false;
    bot.callbackQuery(/^zz:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await editHtml(ctx, html`confirmation`);
      resolved = true;
    });

    await bot.handleUpdate(callbackUpdate({ updateId: 1, data: 'zz:same' }));

    expect(resolved).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
  });
});

describe('undo', () => {
  it("refuses a tap from a user who isn't the creator", async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' }));
    calls.length = 0;

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
});

describe('callback data', () => {
  it('is exp:undo:<uuid>, 45 bytes', () => {
    const data = undoExpenseData(EXPENSE_ID as ExpenseId);
    expect(data).toBe(`exp:undo:${EXPENSE_ID}`);
    expect(Buffer.byteLength(data, 'utf8')).toBe(45);
  });

  it('is exp:restore:<uuid>, 48 bytes', () => {
    const data = restoreExpenseData(EXPENSE_ID as ExpenseId);
    expect(data).toBe(`exp:restore:${EXPENSE_ID}`);
    expect(Buffer.byteLength(data, 'utf8')).toBe(48);
  });

  it('is exp:cat:<uuid> at 44 bytes, exp:catp at 47 and exp:show at 45', () => {
    const id = EXPENSE_ID as ExpenseId;
    expect(categoryPickerData(id)).toBe(`exp:cat:${EXPENSE_ID}`);
    expect(Buffer.byteLength(categoryPickerData(id), 'utf8')).toBe(44);
    expect(categoryPageData(id, 3)).toBe(`exp:catp:${EXPENSE_ID}:3`);
    expect(Buffer.byteLength(categoryPageData(id, 3), 'utf8')).toBe(47);
    expect(showExpenseData(id)).toBe(`exp:show:${EXPENSE_ID}`);
    expect(Buffer.byteLength(showExpenseData(id), 'utf8')).toBe(45);
  });

  it('fits exp:setcat with a 16-digit category id in 64 bytes', () => {
    const data = setCategoryData(EXPENSE_ID as ExpenseId, 1_234_567_890_123_456 as CategoryId);
    expect(data).toMatch(new RegExp(`^exp:setcat:${EXPENSE_ID}:\\d{16}$`));
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('asserts the 64-byte limit', () => {
    expect(assertCallbackData('x'.repeat(64))).toBe('x'.repeat(64));
    expect(() => assertCallbackData('x'.repeat(65))).toThrow(/65 bytes/);
    expect(() => assertCallbackData('я'.repeat(33))).toThrow(/66 bytes/);
  });
});

describe('category picker on the card', () => {
  const NOW = new Date('2026-09-30T10:00:00Z');
  // A new user's personal ledger is seeded in preset order: ids 1..10.
  const categoryIds = Object.fromEntries(CATEGORY_PRESETS.map((p, i) => [p.key, i + 1]));
  const setcat = (key: string) => `exp:setcat:${EXPENSE_ID}:${String(categoryIds[key])}`;
  const button = (key: string, text?: string) => ({
    text: text ?? CATEGORY_PRESETS.find((p) => p.key === key)?.name,
    callback_data: setcat(key),
  });
  const back = [{ text: '« Назад', callback_data: `exp:show:${EXPENSE_ID}` }];
  const pickerText = 'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе\nВыберите категорию:';

  async function recorded() {
    const harness = createTestBot({ now: NOW });
    await harness.bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '450 кофе', date: NOW }),
    );
    harness.calls.length = 0;
    return harness;
  }

  function storedCategory(db: Db): unknown {
    return db.prepare('SELECT category_id FROM expenses').pluck().get();
  }

  function edit(text: string, inline_keyboard: unknown[]) {
    return {
      method: 'editMessageText',
      payload: {
        chat_id: ALLOWED_ID,
        message_id: 2,
        text,
        reply_markup: { inline_keyboard },
        ...htmlParseMode,
      },
    };
  }

  it('opens page 1 of the active categories, two per row, the current one marked', async () => {
    const { bot, calls } = await recorded();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `exp:cat:${EXPENSE_ID}` }));

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
      edit(pickerText, [
        [button('groceries'), button('cafe', '✓ Кафе и рестораны')],
        [button('transport'), button('housing')],
        [button('health'), button('clothes')],
        [button('fun'), button('telecom')],
        [
          { text: '1/2', callback_data: `exp:catp:${EXPENSE_ID}:1` },
          { text: '▶', callback_data: `exp:catp:${EXPENSE_ID}:2` },
        ],
        back,
      ]),
    ]);
  });

  it('renders the last page for a page past the end', async () => {
    const { bot, calls } = await recorded();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `exp:catp:${EXPENSE_ID}:9` }));

    expect(calls[1]).toEqual(
      edit(pickerText, [
        [button('gifts'), button('other')],
        [
          { text: '◀', callback_data: `exp:catp:${EXPENSE_ID}:1` },
          { text: '2/2', callback_data: `exp:catp:${EXPENSE_ID}:2` },
        ],
        back,
      ]),
    );
  });

  it('sets Продукты and edits back to the card; a second tap only toasts', async () => {
    const { bot, calls, db } = await recorded();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: setcat('groceries') }));
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: setcat('groceries') }));

    expect(storedCategory(db)).toBe(categoryIds.groceries);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: messages.categoryChangedToast },
      },
      edit(
        'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Продукты',
        undoKeyboard.inline_keyboard,
      ),
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-3', text: messages.categoryUnchanged },
      },
    ]);
  });

  it('goes back from the picker to the card', async () => {
    const { bot, calls } = await recorded();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `exp:show:${EXPENSE_ID}` }));

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
      edit(
        'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны',
        undoKeyboard.inline_keyboard,
      ),
    ]);
  });

  it.each([
    ['the tapper is not the creator', SECOND_ALLOWED_ID, setcat('groceries'), 'categoryForbidden'],
    // The second user's ledger is seeded after the first one's: its categories are 11..20.
    [
      'the category belongs to another ledger',
      ALLOWED_ID,
      `exp:setcat:${EXPENSE_ID}:11`,
      'categoryUnavailable',
    ],
    ['the category is archived', ALLOWED_ID, setcat('health'), 'categoryUnavailable'],
    ['the expense is undone', ALLOWED_ID, setcat('groceries'), 'expenseDeletedToast'],
  ] as const)('refuses the tap when %s, writing nothing', async (_case, fromId, data, toast) => {
    const { bot, calls, db } = await recorded();
    await bot.handleUpdate(textUpdate({ updateId: 5, fromId: SECOND_ALLOWED_ID, text: '/start' }));
    db.prepare("UPDATE categories SET archived_at = 'x' WHERE id = ?").run(categoryIds.health);
    if (toast === 'expenseDeletedToast') {
      await bot.handleUpdate(callbackUpdate({ updateId: 6, data: `exp:undo:${EXPENSE_ID}` }));
    }
    calls.length = 0;

    await bot.handleUpdate(callbackUpdate({ updateId: 2, fromId, data }));

    expect(storedCategory(db)).toBe(categoryIds.cafe);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: messages[toast] },
      },
    ]);
  });
});

describe('/today', () => {
  const NOW = new Date('2026-09-30T10:00:00Z');

  it('shows the local day per currency, excluding the previous local day and undone', async () => {
    const { bot, calls, db } = createTestBot({ now: NOW });
    const sends: [string, string][] = [
      ['450 coffee', '2026-09-29T22:30:00Z'],
      ['12.50 bread', '2026-09-30T08:00:00Z'],
      ['12.50 EUR taxi', '2026-09-30T09:00:00Z'],
      ['100 late snack', '2026-09-29T21:30:00Z'],
      ['50 mistake', '2026-09-30T09:30:00Z'],
    ];
    for (const [i, [text, sentAt]] of sends.entries()) {
      await bot.handleUpdate(
        textUpdate({ updateId: i + 1, messageId: i + 10, text, date: new Date(sentAt) }),
      );
    }
    const mistakeId = db
      .prepare("SELECT id FROM expenses WHERE description = 'mistake'")
      .pluck()
      .get() as string;
    await bot.handleUpdate(callbackUpdate({ updateId: 20, data: `exp:undo:${mistakeId}` }));
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 21, messageId: 30, text: '/today' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: '<b>Сегодня, 30 сентября — «Личные расходы»</b>\n462.50 RSD\n12.50 EUR',
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('answers an empty day with the nothing-recorded text', async () => {
    const { bot, calls } = createTestBot({ now: NOW });

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/today' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: '<b>Сегодня, 30 сентября — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
          ...htmlParseMode,
        },
      },
    ]);
  });
});
