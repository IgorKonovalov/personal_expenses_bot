import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { CategoryId } from '../db/categories.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import type { UserId } from '../db/users.js';
import { CATEGORY_PRESETS } from '../domain/categoryPresets.js';
import { CURRENCY_CODES, toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { monthOf, weekOf } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { createBot, registerCommands } from './bot.js';
import {
  assertCallbackData,
  categoryPageData,
  categoryPickerData,
  editExpenseData,
  editFieldData,
  restoreExpenseData,
  setExpenseDateData,
  setCategoryData,
  showExpenseData,
  summaryPageData,
  undoExpenseData,
} from './callbackData.js';
import { messages } from './messages.js';
import { editHtml, html, htmlParseMode } from './render/html.js';
import {
  ALLOWED_ID,
  SECOND_ALLOWED_ID,
  STRANGER_ID,
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
// The recorded card's keyboard: [Категория] [Изменить] above [Удалить].
const undoKeyboard = {
  inline_keyboard: [
    [
      { text: 'Категория', callback_data: `exp:cat:${EXPENSE_ID}` },
      { text: 'Изменить', callback_data: `exp:edit:${EXPENSE_ID}` },
    ],
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
  keyboard: [
    [{ text: '📊 Сегодня' }, { text: '📅 Неделя' }, { text: '🗓 Месяц' }],
    [{ text: '⚙️ Настройки' }, { text: '❓ Помощь' }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};
const withMenu = { reply_markup: menuKeyboard, ...htmlParseMode };
// The welcome for a user on the defaults.
const WELCOME =
  'Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу. Итоги за сегодня: /today.' +
  '\n\nЧасовой пояс: Белград (Europe/Belgrade). Валюта: RSD. Изменить: /settings.';

function expenseCount(db: Db): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM expenses').get();
}

function sentTexts(calls: readonly ApiCall[]): unknown[] {
  return calls.map((call) => (call.payload as { text?: unknown }).text);
}

describe('menu and help', () => {
  const NOW = new Date('2026-09-30T10:00:00Z');

  it('takes its labels from messages.menu', () => {
    expect(messages.menu).toEqual({
      today: '📊 Сегодня',
      week: '📅 Неделя',
      month: '🗓 Месяц',
      settings: '⚙️ Настройки',
      help: '❓ Помощь',
    });
  });

  it('carries the persistent menu on the /start and /help replies', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/help' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: ALLOWED_ID, text: WELCOME, ...withMenu },
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
          parseExpenseText(label, currency, '2026-09-30' as LocalDate).kind,
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
      'Изменение сообщения не меняет запись. Нажмите «Изменить» под подтверждением.',
    );
    expect(messages.genericError).toBe(
      'Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не записалась.',
    );
  });
});

describe('command registration at boot', () => {
  it('registers /today, /week, /month, /categories, /settings, /help and /changelog from messages', async () => {
    const { bot, calls } = createTestBot();

    await registerCommands(bot, silentLogger());

    expect(calls).toEqual([
      {
        method: 'setMyCommands',
        payload: {
          commands: [
            { command: 'today', description: messages.commands[0].description },
            { command: 'week', description: 'Траты за неделю по категориям' },
            { command: 'month', description: 'Траты за месяц по категориям' },
            { command: 'categories', description: messages.commands[3].description },
            { command: 'settings', description: 'Часовой пояс и валюта' },
            { command: 'help', description: messages.commands[5].description },
            { command: 'changelog', description: 'Что нового в боте' },
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

describe('/changelog', () => {
  const TRUNCATED = 'Более ранние версии не поместились.';

  it('lists every announced version, newest first', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/changelog' }));

    // Derived from the live map, so a close that adds the next version's entry keeps this green.
    const newestFirst = Object.keys(messages.versionAnnouncements).sort((x, y) =>
      y.localeCompare(x, 'en', { numeric: true }),
    );
    const sections = newestFirst.map(
      (v) => `<b>${v}</b>\n${String(messages.versionAnnouncements[v])}`,
    );
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: `<b>Что нового</b>\n\n${sections.join('\n\n')}`,
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('sorts by version number, not by insertion order', () => {
    const text = messages.changelog({ '0.9.0': html`девять`, '0.10.0': html`десять` });

    expect(text).toBe('<b>Что нового</b>\n\n<b>0.10.0</b>\nдесять\n\n<b>0.9.0</b>\nдевять');
  });

  it('keeps the newest entries under 4096 characters and ends with the truncation line', () => {
    const body = html`${'я'.repeat(300)}`;
    const announcements = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`0.${String(i)}.0`, body]),
    );

    const text = messages.changelog(announcements);

    expect(text.length).toBeLessThan(4096);
    expect(text.startsWith(`<b>Что нового</b>\n\n<b>0.39.0</b>\n${body}\n\n<b>0.38.0</b>`)).toBe(
      true,
    );
    expect(text.endsWith(`\n\n${TRUNCATED}`)).toBe(true);
    expect(text).not.toContain('<b>0.0.0</b>');
    // Only whole entries are dropped: every shown body is complete.
    expect(
      text
        .split('\n\n')
        .slice(1, -1)
        .every((entry) => entry.endsWith(body)),
    ).toBe(true);
  });

  it('has no truncation line when everything fits', () => {
    expect(messages.changelog(messages.versionAnnouncements)).not.toContain(TRUNCATED);
  });

  it('is in the command menu and the help text', () => {
    expect(messages.commands.map((c) => c.command)).toContain('changelog');
    expect(messages.help).toContain('/changelog');
  });

  it('answers nothing to a user outside the allow-list', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, fromId: STRANGER_ID, text: '/changelog' }));

    expect(calls).toEqual([]);
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

describe('recording an expense on a past date', () => {
  // The default message is sent 23:50 on 29 September local.
  it('names the date in the confirmation of 450 такси вчера', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 такси вчера' }));

    expect(db.prepare('SELECT occurred_on FROM expenses').pluck().get()).toBe('2026-09-28');
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Записано в «Личные расходы» за 28 сентября: <b>450.00 RSD</b> — такси · Транспорт',
          reply_markup: undoKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('names the year of a date in another year', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 такси 05.10' }));

    expect(sentTexts(calls)).toEqual([
      'Записано в «Личные расходы» за 5 октября 2025: <b>450.00 RSD</b> — такси · Транспорт',
    ]);
  });

  it('keeps the plain wording for a date word naming today', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 такси 29.09' }));

    expect(sentTexts(calls)).toEqual([
      'Записано в «Личные расходы»: <b>450.00 RSD</b> — такси · Транспорт',
    ]);
  });

  it('keeps the date on the card re-rendered after a category change', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 такси вчера' }));
    const groceries = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'groceries'")
      .pluck()
      .get() as CategoryId;
    calls.length = 0;

    await bot.handleUpdate(
      callbackUpdate({ updateId: 2, data: setCategoryData(EXPENSE_ID as ExpenseId, groceries) }),
    );

    expect(calls[1]).toMatchObject({
      method: 'editMessageText',
      payload: {
        text: 'Записано в «Личные расходы» за 28 сентября: <b>450.00 RSD</b> — такси · Продукты',
      },
    });
  });

  it('refuses a future date with the future-date reply and records nothing', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '450 такси 05.10.2026' }),
    );

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: ALLOWED_ID, text: messages.futureDate, ...htmlParseMode },
      },
    ]);
    expect(expenseCount(db)).toEqual({ n: 0 });
  });

  it('pins the future-date copy', () => {
    expect(messages.futureDate).toBe(
      'Эта дата ещё не наступила. Ничего не записано. Укажите прошедшую дату, например ' +
        '«450 такси вчера» или «450 такси 25.09».',
    );
  });

  it('leaves a past-dated expense out of /today', async () => {
    const NOW = new Date('2026-09-30T10:00:00Z');
    const { bot, calls } = createTestBot({ now: NOW });
    await bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '450 такси вчера', date: NOW }),
    );
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 2, messageId: 11, text: '/today' }));

    expect(sentTexts(calls)).toEqual([
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
    ]);
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

describe('editing an expense from its card', () => {
  // Wednesday 30 September, 12:00 local.
  const NOW = new Date('2026-09-30T10:00:00Z');
  const ID = EXPENSE_ID as ExpenseId;
  const CARD = 'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны';
  const AMOUNT_PROMPT =
    'Сейчас: 450.00 RSD. Введите новую сумму, например «1 200» или «12,50 EUR».';
  const cancelRow = [{ text: 'Отмена', callback_data: `exp:show:${EXPENSE_ID}` }];

  // 450 кофе recorded as message 10; its card is message 2, the callbacks' default.
  async function recorded(now = NOW) {
    const harness = createTestBot({ now, logLevel: 'info' });
    let updateId = 0;
    const say = (text: string, messageId: number) =>
      harness.bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId, text, date: NOW }));
    const tap = (data: string, fromId = ALLOWED_ID) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, fromId }));
    await say('450 кофе', 10);
    harness.calls.length = 0;
    return { ...harness, say, tap };
  }

  // The card turned into the field's prompt.
  async function prompting(field: 'a' | 'd' | 't', now = NOW) {
    const harness = await recorded(now);
    await harness.tap(`exp:edit:${ID}`);
    await harness.tap(`exp:ef:${ID}:${field}`);
    harness.calls.length = 0;
    return harness;
  }

  function row(db: Db): Record<string, unknown> {
    return db
      .prepare(
        `SELECT amount_minor, currency, description, description_key, category_id, occurred_at,
                occurred_on, updated_at FROM expenses WHERE id = ?`,
      )
      .get(ID) as Record<string, unknown>;
  }

  function cardEdit(text: string, reply_markup: unknown = undoKeyboard) {
    return {
      method: 'editMessageText',
      payload: { chat_id: ALLOWED_ID, message_id: 2, text, reply_markup, ...htmlParseMode },
    };
  }

  it('builds exp:edit and exp:ef at 45 bytes and exp:dt at 54', () => {
    expect(Buffer.byteLength(editExpenseData(ID))).toBe(45);
    expect(Buffer.byteLength(editFieldData(ID, 'a'))).toBe(45);
    expect(Buffer.byteLength(setExpenseDateData(ID, '2026-09-29' as LocalDate))).toBe(54);
  });

  it('opens the field picker in the card with [« Назад] alone below', async () => {
    const { tap, calls } = await recorded();

    await tap(`exp:edit:${ID}`);

    expect(calls[1]).toEqual(
      cardEdit('Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе\nЧто изменить?', {
        inline_keyboard: [
          [
            { text: 'Сумма', callback_data: `exp:ef:${ID}:a` },
            { text: 'Описание', callback_data: `exp:ef:${ID}:d` },
            { text: 'Дата', callback_data: `exp:ef:${ID}:t` },
          ],
          [{ text: '« Назад', callback_data: `exp:show:${ID}` }],
        ],
      }),
    );
  });

  it('asks for the amount in the card, and [Отмена] restores the card unchanged', async () => {
    const { tap, calls, db } = await recorded();
    const before = row(db);
    await tap(`exp:edit:${ID}`);
    calls.length = 0;

    await tap(`exp:ef:${ID}:a`);
    await tap(`exp:show:${ID}`);

    expect(calls[1]).toEqual(cardEdit(AMOUNT_PROMPT, { inline_keyboard: [cancelRow] }));
    expect(calls[3]).toEqual(cardEdit(CARD));
    expect(row(db)).toEqual(before);
  });

  it('[Отмена] restores the card after /week moved the anchor, and ends the edit', async () => {
    const { say, tap, calls, db } = await prompting('a');
    const before = row(db);
    await say('/week', 11);
    calls.length = 0;

    await tap(`exp:show:${ID}`);

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-5' } },
      cardEdit(CARD),
    ]);
    calls.length = 0;
    await say('50 чай', 12);
    expect(row(db)).toEqual(before);
    expect(expenseCount(db)).toEqual({ n: 2 });
  });

  it("[Отмена] on one card's prompt leaves another card's pending edit alone", async () => {
    const { say, tap, db } = await recorded();
    await say('700 такси', 11);
    const other = db.prepare('SELECT id FROM expenses WHERE description = ?').get('такси') as {
      id: string;
    };
    await tap(`exp:edit:${ID}`);
    await tap(`exp:ef:${ID}:a`);
    await tap(`exp:edit:${other.id}`);
    await tap(`exp:ef:${other.id}:a`);

    await tap(`exp:show:${ID}`);
    await say('900', 12);

    expect(db.prepare('SELECT amount_minor FROM expenses WHERE id = ?').get(other.id)).toEqual({
      amount_minor: 90000,
    });
    expect(expenseCount(db)).toEqual({ n: 2 });
  });

  it('sets 1 200 as 120000 RSD, re-renders the card, and /today shows it', async () => {
    const { say, calls, db } = await prompting('a');

    await say('1 200', 11);

    expect(row(db)).toMatchObject({
      amount_minor: 120000,
      currency: 'RSD',
      updated_at: '2026-09-30T10:00:00.000Z',
    });
    expect(calls).toEqual([
      cardEdit('Записано в «Личные расходы»: <b>1 200.00 RSD</b> — кофе · Кафе и рестораны'),
    ]);
    calls.length = 0;
    await say('/today', 12);
    expect(sentTexts(calls)).toEqual([
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\n1 200.00 RSD',
    ]);
  });

  it('sets 12,5 EUR as 1250 EUR', async () => {
    const { say, db } = await prompting('a');

    await say('12,5 EUR', 11);

    expect(row(db)).toMatchObject({ amount_minor: 1250, currency: 'EUR' });
  });

  it('re-asks 1.200 with both readings, changes nothing, and keeps the flow', async () => {
    const { say, calls, db } = await prompting('a');
    const before = row(db);

    await say('1.200', 11);

    expect(calls).toEqual([
      cardEdit(
        'Сумму можно понять по-разному: 1 200.00 RSD или 1.20 RSD. Ничего не изменено. ' +
          'Тысячи отделяйте пробелом («1 200»), копейки — запятой («1,20»).\n' +
          AMOUNT_PROMPT,
        { inline_keyboard: [cancelRow] },
      ),
    ]);
    expect(row(db)).toEqual(before);
    await say('1 200', 12);
    expect(row(db)).toMatchObject({ amount_minor: 120000 });
  });

  it('re-asks abc, and 450 кофе with the expense-shaped hint, recording nothing', async () => {
    const { say, calls, db } = await prompting('a');
    const before = row(db);

    await say('abc', 11);
    await say('450 кофе', 12);

    expect(sentTexts(calls)).toEqual([
      `Не удалось разобрать сумму.\n${AMOUNT_PROMPT}`,
      'Похоже на трату. Сейчас я жду новое значение. Чтобы записать трату, нажмите «Отмена» ' +
        `и отправьте её снова.\n${AMOUNT_PROMPT}`,
    ]);
    expect(row(db)).toEqual(before);
    expect(expenseCount(db)).toEqual({ n: 1 });
  });

  it('sets the description and its key, keeping the category; 450 кофе re-asks', async () => {
    const { say, calls, db } = await prompting('d');
    const { category_id } = row(db);

    await say('450 кофе', 11);
    expect(row(db)).toMatchObject({ description: 'кофе' });
    expect(sentTexts(calls)[0]).toContain('Похоже на трату.');
    await say('капучино', 12);

    expect(row(db)).toMatchObject({
      description: 'капучино',
      description_key: 'капучино',
      category_id,
    });
    expect(calls[1]).toEqual(
      cardEdit('Записано в «Личные расходы»: <b>450.00 RSD</b> — капучино · Кафе и рестораны'),
    );
  });

  it('offers absolute quick dates; [Вчера] moves the expense out of /today into /week', async () => {
    const { tap, say, calls, db } = await recorded();
    await tap(`exp:edit:${ID}`);
    calls.length = 0;

    await tap(`exp:ef:${ID}:t`);
    expect(calls[1]).toEqual(
      cardEdit('Сейчас: 30 сентября. Выберите дату или введите её, например «25.09» или «вчера».', {
        inline_keyboard: [
          [
            { text: 'Сегодня', callback_data: `exp:dt:${ID}:2026-09-30` },
            { text: 'Вчера', callback_data: `exp:dt:${ID}:2026-09-29` },
            { text: 'Позавчера', callback_data: `exp:dt:${ID}:2026-09-28` },
          ],
          cancelRow,
        ],
      }),
    );
    await tap(`exp:dt:${ID}:2026-09-29`);

    expect(row(db)).toMatchObject({
      occurred_on: '2026-09-29',
      occurred_at: '2026-09-30T10:00:00.000Z',
      updated_at: '2026-09-30T10:00:00.000Z',
    });
    expect(calls[3]).toEqual(
      cardEdit(
        'Записано в «Личные расходы» за 29 сентября: <b>450.00 RSD</b> — кофе · Кафе и рестораны',
      ),
    );
    calls.length = 0;
    await say('/today', 11);
    await say('/week', 12);
    expect(sentTexts(calls)[0]).toContain('Трат нет.');
    expect(sentTexts(calls)[1]).toContain('<b>450.00 RSD</b>\nКафе и рестораны: 450.00');
  });

  it('sets the button date after local midnight, and a second tap writes nothing', async () => {
    // 01:30 on 1 October local.
    const { tap, calls, db } = await prompting('t', new Date('2026-09-30T23:30:00Z'));

    await tap(`exp:dt:${ID}:2026-09-29`);
    const first = row(db);
    await tap(`exp:dt:${ID}:2026-09-29`);

    expect(first).toMatchObject({ occurred_on: '2026-09-29' });
    expect(row(db)).toEqual(first);
    expect(calls[2]).toMatchObject({
      method: 'answerCallbackQuery',
      payload: { text: messages.dateUnchanged },
    });
  });

  it.each(['2026-10-05', '2026-02-30'])(
    'toasts a forged date %s and writes nothing',
    async (date) => {
      const { tap, calls, db } = await prompting('t');
      const before = row(db);

      await tap(`exp:dt:${ID}:${date}`);

      expect(calls).toEqual([
        {
          method: 'answerCallbackQuery',
          payload: { callback_query_id: 'cb-4', text: messages.dateUnavailable },
        },
      ]);
      expect(row(db)).toEqual(before);
    },
  );

  it('takes a typed 25.09 and re-asks 05.10.2026 as future', async () => {
    const { say, calls, db } = await prompting('t');

    await say('05.10.2026', 11);
    expect(sentTexts(calls)[0]).toMatch(/^Эта дата ещё не наступила\.\nСейчас: 30 сентября\./);
    expect(row(db)).toMatchObject({ occurred_on: '2026-09-30' });
    await say('25.09', 12);

    expect(row(db)).toMatchObject({
      occurred_on: '2026-09-25',
      occurred_at: '2026-09-30T10:00:00.000Z',
    });
  });

  it('refuses every edit button on an undone expense with a toast', async () => {
    const { tap, calls, db } = await recorded();
    await tap(`exp:undo:${ID}`);
    const before = row(db);
    calls.length = 0;

    await tap(`exp:edit:${ID}`);
    await tap(`exp:ef:${ID}:a`);
    await tap(`exp:dt:${ID}:2026-09-29`);

    expect(row(db)).toEqual(before);
    expect(calls.map((call) => (call.payload as { text?: string }).text)).toEqual([
      messages.expenseDeletedToast,
      messages.expenseDeletedToast,
      messages.expenseDeletedToast,
    ]);
  });

  it('toasts editForbidden to a non-author and writes nothing', async () => {
    const { tap, calls, db } = await recorded();
    const before = row(db);

    await tap(`exp:edit:${ID}`, SECOND_ALLOWED_ID);

    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: messages.editForbidden },
      },
    ]);
    expect(row(db)).toEqual(before);
    expect(messages.editForbidden).toBe('Изменить трату может только тот, кто её записал');
  });

  it('writes nothing and clears the flow for an answer after the expense was undone', async () => {
    const { tap, say, calls, db } = await prompting('a');
    await tap(`exp:undo:${ID}`);
    calls.length = 0;

    await say('1 200', 11);
    await say('50 чай', 12);

    expect(row(db)).toMatchObject({ amount_minor: 45000, updated_at: null });
    expect(sentTexts(calls)[0]).toBe(messages.editGone);
    expect(expenseCount(db)).toEqual({ n: 2 });
  });

  it('applies a redelivered answer once, with no second reply', async () => {
    const { bot, calls, db } = await prompting('a');
    const update = textUpdate({ updateId: 50, messageId: 11, text: '1 200', date: NOW });

    await bot.handleUpdate(update);
    const first = row(db);
    await bot.handleUpdate(update);

    expect(calls).toHaveLength(1);
    expect(row(db)).toEqual(first);
    expect(expenseCount(db)).toEqual({ n: 1 });
  });

  it('logs no old or new amount or description at info', async () => {
    const { say, tap, logLines } = await prompting('a');
    await say('1 200', 11);
    await tap(`exp:edit:${ID}`);
    await tap(`exp:ef:${ID}:d`);
    await say('капучино', 12);

    expect(logLines.filter((line) => line.includes('expense edited'))).toHaveLength(2);
    for (const line of logLines) {
      for (const secret of ['450', '1200', '1 200', '120000', 'кофе', 'капучино']) {
        expect(logContent(line)).not.toContain(secret);
      }
    }
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

describe('/week and /month', () => {
  // Wednesday 30 September, 12:00 local.
  const NOW = new Date('2026-09-30T10:00:00Z');
  const botInfo = createTestBot().bot.botInfo;

  // A bot whose sendMessage answers with real message ids (the anchor needs them), holding the
  // plan's fixture ledger A to H once `/start` has provisioned the user.
  async function summaryBot(opts: { fixture?: boolean } = {}) {
    const db = openDatabase(':memory:');
    runMigrations(db, NOW);
    let ids = 0;
    // The /start reply takes 100, so the first screen after it is 101.
    let messageId = 99;
    const bot = createBot({
      token: '123456:test-token',
      allowedTelegramIds: new Set([ALLOWED_ID, SECOND_ALLOWED_ID]),
      logger: silentLogger(),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => NOW,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      botInfo,
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
    const say = (text: string, message: number, date = NOW) =>
      bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId: message, text, date }));
    const tap = (data: string, message: number) =>
      bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId: message }));

    await say('/start', 1);
    const { userId, ledgerId } = db
      .prepare('SELECT id AS userId, active_ledger_id AS ledgerId FROM users')
      .get() as { userId: UserId; ledgerId: LedgerId };
    const categoryOf = (preset: string) =>
      db
        .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
        .pluck()
        .get(ledgerId, preset) as CategoryId;
    const add = (
      id: string,
      occurredOn: string,
      amountMinor: number,
      currency: CurrencyCode,
      preset: string | null,
      ledger: LedgerId = ledgerId,
    ) =>
      insertExpenseOrGetExisting(db, {
        id: id as ExpenseId,
        ledgerId: ledger,
        createdBy: userId,
        amountMinor,
        currency,
        description: 'x',
        occurredAt: NOW,
        occurredOn: occurredOn as LocalDate,
        sourceKey: `fixture:${id}`,
        createdAt: NOW,
        ...(preset === null ? {} : { categoryId: categoryOf(preset) }),
      });
    if (opts.fixture !== false) {
      add('A', '2026-08-31', 10000, 'RSD', 'groceries');
      add('B', '2026-09-01', 45000, 'RSD', 'cafe');
      add('C', '2026-09-15', 120000, 'RSD', 'groceries');
      add('D', '2026-09-28', 30000, 'RSD', 'cafe');
      add('E', '2026-09-30', 1250, 'EUR', 'transport');
      add('F', '2026-09-30', 5000, 'RSD', 'cafe');
      softDeleteExpense(db, 'F' as ExpenseId, NOW);
      add('G', '2026-09-27', 20000, 'RSD', 'transport');
      add('H', '2026-09-29', 7000, 'RSD', null);
    }
    calls.length = 0;
    return { bot, db, calls, say, tap, add, userId, ledgerId };
  }

  const button = (text: string, callback_data: string) => ({ text, callback_data });
  const SEPTEMBER =
    '<b>Сентябрь 2026 — «Личные расходы»</b>\n\n' +
    '<b>2 220.00 RSD</b>\nПродукты: 1 200.00\nКафе и рестораны: 750.00\nТранспорт: 200.00\n' +
    'Без категории: 70.00\n\n' +
    '<b>12.50 EUR</b>\nТранспорт: 12.50';
  const THIS_WEEK =
    '<b>Неделя, 28 сентября – 4 октября — «Личные расходы»</b>\n\n' +
    '<b>370.00 RSD</b>\nКафе и рестораны: 300.00\nБез категории: 70.00\n\n' +
    '<b>12.50 EUR</b>\nТранспорт: 12.50';

  function editOf(message: number, text: string, inline_keyboard: unknown) {
    return {
      method: 'editMessageText',
      payload: {
        chat_id: ALLOWED_ID,
        message_id: message,
        text,
        reply_markup: { inline_keyboard },
        ...htmlParseMode,
      },
    };
  }

  it('shows /month per currency, the ledger default first, with only [◀ Август]', async () => {
    const { say, calls } = await summaryBot();

    await say('/month', 2);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: SEPTEMBER,
          reply_markup: { inline_keyboard: [[button('◀ Август', 'sum:m:2026-08')]] },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('shows /week Monday to Sunday without G (Sunday the 27th) or F (undone)', async () => {
    const { say, calls } = await summaryBot();

    await say('/week', 2);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: THIS_WEEK,
          reply_markup: { inline_keyboard: [[button('◀ 21–27 сен', 'sum:w:2026-09-21')]] },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('pages the month in place to August, which names July and September', async () => {
    const { say, tap, calls } = await summaryBot();
    await say('/month', 2);
    calls.length = 0;

    await tap('sum:m:2026-08', 101);

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-3' } },
      editOf(101, '<b>Август 2026 — «Личные расходы»</b>\n\n<b>100.00 RSD</b>\nПродукты: 100.00', [
        [button('◀ Июль', 'sum:m:2026-07'), button('Сентябрь ▶', 'sum:m:2026-09')],
      ]),
    ]);
  });

  it('pages the week to 21–27 September, which names both neighbours', async () => {
    const { say, tap, calls } = await summaryBot();
    await say('/week', 2);
    calls.length = 0;

    await tap('sum:w:2026-09-21', 101);

    expect(calls[1]).toEqual(
      editOf(
        101,
        '<b>Неделя, 21–27 сентября — «Личные расходы»</b>\n\n<b>200.00 RSD</b>\nТранспорт: 200.00',
        [
          [
            button('◀ 14–20 сен', 'sum:w:2026-09-14'),
            button('28 сен – 4 окт ▶', 'sum:w:2026-09-28'),
          ],
        ],
      ),
    );
  });

  it('pages the ledger stored in the screen, not the one active at tap time', async () => {
    const { db, say, tap, calls, add, userId } = await summaryBot();
    await say('/month', 2);
    const other = 'ledger-other' as LedgerId;
    db.prepare(
      `INSERT INTO ledgers (id, kind, name, default_currency, owner_user_id, created_at)
       VALUES (?, 'shared', 'Дом', 'RSD', ?, ?)`,
    ).run(other, userId, NOW.toISOString());
    db.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES (?, ?, 'owner')").run(
      other,
      userId,
    );
    add('Z', '2026-08-10', 99900, 'RSD', null, other);
    db.prepare('UPDATE users SET active_ledger_id = ?').run(other);
    calls.length = 0;

    await tap('sum:m:2026-08', 101);

    expect(calls[1]).toMatchObject({
      payload: {
        text: '<b>Август 2026 — «Личные расходы»</b>\n\n<b>100.00 RSD</b>\nПродукты: 100.00',
      },
    });
  });

  it('holds the ledger id in screen_ctx', async () => {
    const { db, say, ledgerId } = await summaryBot();

    await say('/week', 2);

    expect(
      db.prepare('SELECT screen, screen_ctx, anchor_message_id FROM flow_sessions').get(),
    ).toEqual({
      screen: 'summary',
      screen_ctx: JSON.stringify({ ledgerId }),
      anchor_message_id: 101,
    });
  });

  it('toasts staleScreen on a pager tap once /categories opened a newer screen', async () => {
    const { say, tap, calls } = await summaryBot();
    await say('/month', 2);
    await say('/categories', 3);
    calls.length = 0;

    await tap('sum:m:2026-08', 101);

    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-4', text: messages.staleScreen },
      },
    ]);
  });

  it('answers a malformed or future period silently and edits nothing', async () => {
    const { say, tap, calls } = await summaryBot();
    await say('/month', 2);
    calls.length = 0;

    await tap('sum:m:2026-13', 101);
    await tap('sum:w:2026-09-29', 101);
    await tap('sum:m:2026-10', 101);

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-3' } },
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-4' } },
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-5' } },
    ]);
  });

  it('interpolates category names through html', async () => {
    const { db, say, calls, ledgerId } = await summaryBot();
    db.prepare(
      "UPDATE categories SET name = 'Кафе <b>&</b>' WHERE ledger_id = ? AND preset_key = 'cafe'",
    ).run(ledgerId);

    await say('/week', 2);

    expect(sentTexts(calls)[0]).toContain('\nКафе &lt;b&gt;&amp;&lt;/b&gt;: 300.00\n');
  });

  it('shows the header and the no-expenses line for an empty period', async () => {
    const { say, calls } = await summaryBot({ fixture: false });

    await say('/month', 2);

    expect(sentTexts(calls)).toEqual([
      '<b>Сентябрь 2026 — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
    ]);
  });

  it('counts 450 кофе sent at 00:30 on 1 September local in September, not August', async () => {
    const { say, tap, calls } = await summaryBot({ fixture: false });
    await say('450 кофе', 2, new Date('2026-08-31T22:30:00Z'));
    calls.length = 0;

    await say('/month', 3);
    await tap('sum:m:2026-08', 102);

    expect(sentTexts(calls)[0]).toBe(
      '<b>Сентябрь 2026 — «Личные расходы»</b>\n\n<b>450.00 RSD</b>\nКафе и рестораны: 450.00',
    );
    expect(calls[2]).toMatchObject({
      method: 'editMessageText',
      payload: {
        text: '<b>Август 2026 — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
      },
    });
  });

  it.each([
    ['📅 Неделя', '/week'],
    ['🗓 Месяц', '/month'],
  ])('answers the %s label exactly like %s', async (label, command) => {
    const { say, calls } = await summaryBot();

    await say(command, 2);
    await say(label, 3);

    expect(calls).toHaveLength(2);
    expect((calls[1]?.payload as { text: string }).text).toBe(
      (calls[0]?.payload as { text: string }).text,
    );
    expect(calls[1]).toEqual(calls[0]);
  });

  it('builds sum:m at 13 bytes and sum:w at 16', () => {
    expect(Buffer.byteLength(summaryPageData(monthOf('2026-09-30' as LocalDate)))).toBe(13);
    expect(summaryPageData(monthOf('2026-09-30' as LocalDate))).toBe('sum:m:2026-09');
    expect(summaryPageData(weekOf('2026-09-30' as LocalDate))).toBe('sum:w:2026-09-28');
    expect(Buffer.byteLength(summaryPageData(weekOf('2026-09-30' as LocalDate)))).toBe(16);
  });

  describe('length', () => {
    // Tags and entity escapes are not visible text (ADR-0012).
    const visible = (text: string) =>
      text.replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|amp|quot);/g, '_').length;
    const view = (categories: number) => ({
      ledger: { kind: 'personal' as const, name: 'Personal' },
      period: {
        kind: 'month' as const,
        from: '2026-09-01' as LocalDate,
        to: '2026-09-30' as LocalDate,
      },
      currencies: CURRENCY_CODES.map((currency) => ({
        currency,
        totalMinor: categories * 123456789,
        lines: Array.from({ length: categories }, (_, i) => ({
          name: `Категория с длинным именем ${String(i).padStart(5, '0')}`,
          amountMinor: 123456789,
        })),
      })),
    });

    it('falls back to totals per currency within 4096 visible characters', () => {
      const text = messages.periodSummary(view(30));

      expect(visible(text)).toBeLessThanOrEqual(4096);
      expect(text).not.toContain('Категория с длинным именем');
      expect(text).toContain(
        'Категорий слишком много для одного сообщения, поэтому показаны только итоги.',
      );
      for (const currency of CURRENCY_CODES) expect(text).toContain(` ${currency}</b>`);
    });

    it('keeps the categories when they fit', () => {
      const text = messages.periodSummary(view(1));

      expect(visible(text)).toBeLessThanOrEqual(4096);
      expect(text).toContain('Категория с длинным именем 00000');
      expect(text).not.toContain('Категорий слишком много');
    });
  });
});

describe('/categories screen and text flows', () => {
  const T = new Date('2026-09-30T10:00:00Z');
  const MIN = 60 * 1000;
  const botInfo = createTestBot().bot.botInfo;
  let ids = 0;
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function fileDb(): string {
    dir = mkdtempSync(join(tmpdir(), 'expenses-bot-'));
    return join(dir, 'bot.sqlite');
  }

  // A bot with a movable clock whose sendMessage answers with real message ids (the anchor needs
  // them), optionally on a database a previous instance used.
  function flowBot(opts: { db?: Db; firstMessageId?: number } = {}) {
    const clock = { now: T };
    const db =
      opts.db ??
      (() => {
        const memory = openDatabase(':memory:');
        runMigrations(memory, T);
        return memory;
      })();
    let messageId = opts.firstMessageId ?? 100;
    const bot = createBot({
      token: '123456:test-token',
      allowedTelegramIds: new Set([ALLOWED_ID, SECOND_ALLOWED_ID]),
      logger: silentLogger(),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => clock.now,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      botInfo,
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
    const say = (text: string, messageId: number) =>
      bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId, text, date: clock.now }));
    const tap = (data: string, messageId: number) =>
      bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId }));
    return { bot, db, calls, clock, say, tap };
  }

  const PRESET_NAMES = CATEGORY_PRESETS.map((p) => p.name);
  const screenText = (names: readonly string[], header?: string) =>
    (header === undefined ? '' : `${header}\n\n`) +
    ['<b>Категории «Личные расходы»</b>', ...names].join('\n');
  const screenKeyboard = {
    inline_keyboard: [
      [{ text: 'Добавить', callback_data: 'cat:add' }],
      [
        { text: 'Переименовать', callback_data: 'cat:ren' },
        { text: 'Скрыть', callback_data: 'cat:arc' },
      ],
    ],
  };
  const cancelKeyboard = { inline_keyboard: [[{ text: 'Отмена', callback_data: 'flow:cancel' }]] };
  const ADD_PROMPT = 'Как назвать новую категорию? До 32 символов.';

  function editOf(messageId: number, text: string, reply_markup: unknown) {
    return {
      method: 'editMessageText',
      payload: { chat_id: ALLOWED_ID, message_id: messageId, text, reply_markup, ...htmlParseMode },
    };
  }

  function categoryCount(db: Db): unknown {
    return db.prepare('SELECT COUNT(*) FROM categories').pluck().get();
  }

  function expenseTotal(db: Db): unknown {
    return db.prepare('SELECT COUNT(*) FROM expenses').pluck().get();
  }

  // /categories (anchor 101), then [Добавить] on it.
  async function adding(opts: Parameters<typeof flowBot>[0] = {}) {
    const harness = flowBot(opts);
    await harness.say('/categories', 1);
    await harness.tap('cat:add', 101);
    harness.calls.length = 0;
    return harness;
  }

  it('sends the screen as a new message listing the active categories', async () => {
    const { say, calls } = flowBot();

    await say('/categories', 1);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: screenText(PRESET_NAMES),
          reply_markup: screenKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('opens the rename picker with a pager and back, and leaves «Другое» out of hide', async () => {
    const { say, tap, calls, db } = flowBot();
    await say('/categories', 1);
    const idOf = (name: string) =>
      db.prepare('SELECT id FROM categories WHERE name = ?').pluck().get(name) as number;
    calls.length = 0;

    await tap('cat:ren', 101);
    await tap('cat:arcp:2', 101);
    await tap('cat:arc', 101);

    const renameButtons = PRESET_NAMES.slice(0, 8).map((name) => ({
      text: name,
      callback_data: `cat:ren:${String(idOf(name))}`,
    }));
    expect(calls[1]).toEqual(
      editOf(101, 'Какую категорию переименовать?', {
        inline_keyboard: [
          ...[0, 2, 4, 6].map((i) => renameButtons.slice(i, i + 2)),
          [
            { text: '1/2', callback_data: 'cat:renp:1' },
            { text: '▶', callback_data: 'cat:renp:2' },
          ],
          [{ text: '« Назад', callback_data: 'cat:open' }],
        ],
      }),
    );
    // The hide picker's last page holds the ninth preset and no «Другое».
    expect(calls[3]).toEqual(
      editOf(101, 'Какую категорию скрыть? Её можно вернуть, добавив снова.', {
        inline_keyboard: [
          [{ text: 'Подарки', callback_data: `cat:arc:${String(idOf('Подарки'))}` }],
          [
            { text: '◀', callback_data: 'cat:arcp:1' },
            { text: '2/2', callback_data: 'cat:arcp:2' },
          ],
          [{ text: '« Назад', callback_data: 'cat:open' }],
        ],
      }),
    );
    expect(JSON.stringify(calls)).not.toContain('Другое');
  });

  it('hides a category without asking and re-renders the screen', async () => {
    const { say, tap, calls, db } = flowBot();
    await say('/categories', 1);
    const gifts = db.prepare("SELECT id FROM categories WHERE name = 'Подарки'").pluck().get();
    calls.length = 0;

    await tap(`cat:arc:${String(gifts)}`, 101);

    expect(calls[1]).toEqual(
      editOf(
        101,
        screenText(
          PRESET_NAMES.filter((n) => n !== 'Подарки'),
          'Категория «Подарки» скрыта. Чтобы вернуть её, добавьте её снова.',
        ),
        screenKeyboard,
      ),
    );
    expect(db.prepare('SELECT archived_at FROM categories WHERE id = ?').pluck().get(gifts)).toBe(
      '2026-09-30T10:00:00.000Z',
    );
  });

  it('toasts staleScreen on the first of two /categories, and a card still works', async () => {
    const { say, tap, calls, db } = flowBot();
    await say('450 кофе', 1);
    const expenseId = db.prepare('SELECT id FROM expenses').pluck().get() as string;
    await say('/categories', 2);
    await say('/categories', 3);
    calls.length = 0;

    await tap('cat:add', 102);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: `cb-4`, text: messages.staleScreen },
      },
    ]);
    // Nothing is pending: plain text is still an expense attempt.
    calls.length = 0;
    await say('450 чай', 4);
    expect(expenseTotal(db)).toBe(2);

    calls.length = 0;
    await tap(`exp:cat:${expenseId}`, 101);
    expect(calls[1]).toMatchObject({ method: 'editMessageText', payload: { message_id: 101 } });

    calls.length = 0;
    await tap('cat:add', 103);
    expect(calls[1]).toEqual(editOf(103, ADD_PROMPT, cancelKeyboard));
  });

  it('keeps the anchor across a restart on the same database file', async () => {
    const path = fileDb();
    const firstDb = openDatabase(path);
    runMigrations(firstDb, T);
    const first = flowBot({ db: firstDb });
    await first.say('/categories', 1);
    firstDb.close();

    const secondDb = openDatabase(path);
    const second = flowBot({ db: secondDb, firstMessageId: 200 });
    await second.tap('cat:add', 101);

    expect(second.calls[1]).toEqual(editOf(101, ADD_PROMPT, cancelKeyboard));
    secondDb.close();
  });

  it('accepts an answer after a restart', async () => {
    const path = fileDb();
    const firstDb = openDatabase(path);
    runMigrations(firstDb, T);
    await adding({ db: firstDb });
    firstDb.close();

    const secondDb = openDatabase(path);
    const second = flowBot({ db: secondDb, firstMessageId: 200 });
    await second.say('Дача', 5);

    expect(
      secondDb.prepare("SELECT COUNT(*) FROM categories WHERE name = 'Дача'").pluck().get(),
    ).toBe(1);
    expect(second.calls[0]).toMatchObject({
      method: 'editMessageText',
      payload: { message_id: 101 },
    });
    secondDb.close();
  });

  it('adds Дача: prompt, answer, screen headed by the result, and the next picker offers it', async () => {
    const { say, tap, calls, db } = flowBot();
    await say('/categories', 1);
    calls.length = 0;

    await tap('cat:add', 101);
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
      editOf(101, ADD_PROMPT, cancelKeyboard),
    ]);

    calls.length = 0;
    await say('Дача', 2);
    expect(calls).toEqual([
      editOf(
        101,
        screenText([...PRESET_NAMES, 'Дача'], 'Категория «Дача» добавлена.'),
        screenKeyboard,
      ),
    ]);

    await say('450 кофе', 3);
    const expenseId = db.prepare('SELECT id FROM expenses').pluck().get() as string;
    calls.length = 0;
    await tap(`exp:catp:${expenseId}:2`, 102);
    const dacha = db.prepare("SELECT id FROM categories WHERE name = 'Дача'").pluck().get();
    expect(JSON.stringify(calls[1])).toContain(
      `"text":"Дача","callback_data":"exp:setcat:${expenseId}:${String(dacha)}"`,
    );
  });

  it.each([
    ['', 'Название не может быть пустым.'],
    ['я'.repeat(33), 'Название длиннее 32 символов.'],
    [
      '450 кофе',
      'Похоже на трату. Сейчас я жду название категории. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.',
    ],
    ['450', 'Название не может начинаться с цифры.'],
    ['кафе и рестораны', 'Такая категория уже есть.'],
  ])('re-asks %j with its refusal and keeps the flow pending', async (text, refusal) => {
    const { say, calls, db } = await adding();
    const categories = categoryCount(db);

    await say(text === '' ? ' ' : text, 2);
    expect(calls).toEqual([editOf(101, `${refusal}\n${ADD_PROMPT}`, cancelKeyboard)]);
    expect(categoryCount(db)).toBe(categories);
    expect(expenseTotal(db)).toBe(0);

    await say('Дача', 3);
    expect(categoryCount(db)).toBe((categories as number) + 1);
  });

  it('escapes a name in message text and keeps it raw on buttons', async () => {
    const { say, tap, calls } = await adding();

    await say('Дача & <сад>', 2);
    expect(calls[0]).toEqual(
      editOf(
        101,
        screenText(
          [...PRESET_NAMES, 'Дача &amp; &lt;сад&gt;'],
          'Категория «Дача &amp; &lt;сад&gt;» добавлена.',
        ),
        screenKeyboard,
      ),
    );

    calls.length = 0;
    await tap('cat:renp:2', 101);
    expect(JSON.stringify(calls[1])).toContain('"text":"Дача & <сад>"');
  });

  it('renames with a prompt naming the current name, and 450 кофе still lands there', async () => {
    const { say, tap, calls, db } = flowBot();
    await say('/categories', 1);
    const cafe = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'cafe'")
      .pluck()
      .get() as number;
    calls.length = 0;

    await tap(`cat:ren:${String(cafe)}`, 101);
    expect(calls[1]).toEqual(
      editOf(101, 'Новое название для «Кафе и рестораны»? До 32 символов.', cancelKeyboard),
    );
    await say('Кофейни', 2);
    calls.length = 0;
    await say('450 кофе', 3);

    expect(calls[0]).toMatchObject({
      payload: { text: 'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кофейни' },
    });
    expect(
      db.prepare('SELECT id, preset_key FROM categories WHERE name = ?').get('Кофейни'),
    ).toEqual({ id: cafe, preset_key: 'cafe' });
  });

  it('takes Дача at T+9m59s as the answer', async () => {
    const { say, clock, db } = await adding();

    clock.now = new Date(T.getTime() + 9 * MIN + 59_000);
    await say('Дача', 2);

    expect(db.prepare("SELECT COUNT(*) FROM categories WHERE name = 'Дача'").pluck().get()).toBe(1);
  });

  it('answers Дача at T+10m01s with flowExpired, once, and records 450 кофе', async () => {
    const { say, clock, calls, db } = await adding();
    const categories = categoryCount(db);

    clock.now = new Date(T.getTime() + 10 * MIN + 1000);
    await say('Дача', 2);
    await say('Дача', 3);
    await say('450 кофе', 4);

    expect(sentTexts(calls).slice(0, 2)).toEqual([
      'Время ответа истекло. Начните заново: /categories.',
      messages.help,
    ]);
    expect(categoryCount(db)).toBe(categories);
    expect(expenseTotal(db)).toBe(1);
  });

  it('records 450 кофе sent at T+10m01s without a flowExpired reply', async () => {
    const { say, clock, calls, db } = await adding();

    clock.now = new Date(T.getTime() + 10 * MIN + 1000);
    await say('450 кофе', 2);

    expect(expenseTotal(db)).toBe(1);
    expect(sentTexts(calls)).toEqual([
      'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны',
    ]);
  });

  it('answers Дача at T+25h with the ordinary help reply', async () => {
    const { say, clock, calls, db } = await adding();
    const categories = categoryCount(db);

    clock.now = new Date(T.getTime() + 25 * 60 * MIN);
    await say('Дача', 2);

    expect(sentTexts(calls)).toEqual([messages.help]);
    expect(categoryCount(db)).toBe(categories);
  });

  it('creates one category for a redelivered answer, with no reply and no expense', async () => {
    const { bot, calls, db } = await adding();
    const answer = textUpdate({ updateId: 50, messageId: 2, text: 'Дача', date: T });

    await bot.handleUpdate(answer);
    calls.length = 0;
    await bot.handleUpdate(answer);

    expect(db.prepare("SELECT COUNT(*) FROM categories WHERE name = 'Дача'").pluck().get()).toBe(1);
    expect(calls).toEqual([]);
    expect(expenseTotal(db)).toBe(0);
  });

  it.each([
    ['/cancel', true],
    ['[Отмена]', true],
    ['📊 Сегодня', false],
    ['/today', false],
  ])('clears the pending flow on %s, so 450 кофе records', async (action, restores) => {
    const { say, tap, calls, db } = await adding();

    if (action === '[Отмена]') await tap('flow:cancel', 101);
    else await say(action, 2);
    const restored = calls.some(
      (call) =>
        call.method === 'editMessageText' &&
        (call.payload as { text: string }).text === screenText(PRESET_NAMES),
    );
    await say('450 кофе', 3);

    expect(restored).toBe(restores);
    if (restores) {
      expect(calls).toContainEqual(editOf(101, screenText(PRESET_NAMES), screenKeyboard));
    }
    expect(expenseTotal(db)).toBe(1);
  });
});

describe('/settings hub and the timezone picker', () => {
  // 00:30 on the 30th in Moscow, 23:30 on the 29th in Belgrade.
  const LATE = new Date('2026-09-29T21:30:00Z');
  const botInfo = createTestBot().bot.botInfo;

  // Like flowBot above: a movable clock, real message ids from sendMessage, and info logs kept.
  function settingsBot() {
    const clock = { now: LATE };
    const db = openDatabase(':memory:');
    runMigrations(db, LATE);
    const logLines: string[] = [];
    let ids = 0;
    let messageId = 100;
    const bot = createBot({
      token: '123456:test-token',
      allowedTelegramIds: new Set([ALLOWED_ID]),
      logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => clock.now,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      botInfo,
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
      bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId: id, text, date: clock.now }));
    const tap = (data: string, id: number) =>
      bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId: id }));
    const storedTimezone = () => db.prepare('SELECT timezone FROM users').pluck().get();
    const totalChanges = () => db.prepare('SELECT total_changes()').pluck().get();
    return { bot, db, calls, clock, logLines, say, tap, storedTimezone, totalChanges };
  }

  const hubText = (zone = 'Белград (Europe/Belgrade)', currency = 'RSD') =>
    [
      '<b>Настройки</b>',
      `Часовой пояс: ${zone}`,
      `Валюта по умолчанию для новых трат в «Личные расходы»: ${currency}`,
    ].join('\n');
  const hubKeyboard = {
    inline_keyboard: [
      [
        { text: 'Часовой пояс', callback_data: 'set:tz' },
        { text: 'Валюта', callback_data: 'set:cur' },
      ],
      [{ text: 'Категории', callback_data: 'set:cat' }],
    ],
  };
  const cancelKeyboard = { inline_keyboard: [[{ text: 'Отмена', callback_data: 'flow:cancel' }]] };
  const PROMPT =
    'Сейчас: Белград (Europe/Belgrade). Отправьте название часового пояса, например Europe/Istanbul.';

  function editOf(messageId: number, text: string, reply_markup: unknown) {
    return {
      method: 'editMessageText',
      payload: { chat_id: ALLOWED_ID, message_id: messageId, text, reply_markup, ...htmlParseMode },
    };
  }

  it.each(['/settings', '⚙️ Настройки'])('opens the hub as a new screen on %j', async (text) => {
    const { say, tap, calls } = settingsBot();

    await say(text, 1);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: hubText(),
          reply_markup: hubKeyboard,
          ...htmlParseMode,
        },
      },
    ]);

    // The new message is the anchor: a tap on it works, and the older one is stale.
    await say(text, 2);
    calls.length = 0;
    await tap('set:tz', 101);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-3', text: messages.staleScreen },
      },
    ]);
  });

  it('pages the city list with the current zone marked, [Другой…] and [« Назад] below', async () => {
    const { say, tap, calls } = settingsBot();
    await say('/settings', 1);
    calls.length = 0;

    await tap('set:tz', 101);
    await tap('set:tzp:2', 101);

    const picker = 'Выберите часовой пояс. Сейчас: Белград (Europe/Belgrade).';
    const city = (text: string, slug: string) => ({ text, callback_data: `set:tz:${slug}` });
    const tail = [
      [{ text: 'Другой…', callback_data: 'set:tzother' }],
      [{ text: '« Назад', callback_data: 'set:open' }],
    ];
    expect(calls[1]).toEqual(
      editOf(101, picker, {
        inline_keyboard: [
          [city('✓ Белград', 'belgrade'), city('Подгорица', 'podgorica')],
          [city('Москва', 'moscow'), city('Алматы', 'almaty')],
          [city('Калининград', 'kaliningrad'), city('Самара', 'samara')],
          [city('Екатеринбург', 'yekaterinburg'), city('Новосибирск', 'novosibirsk')],
          [
            { text: '1/2', callback_data: 'set:tzp:1' },
            { text: '▶', callback_data: 'set:tzp:2' },
          ],
          ...tail,
        ],
      }),
    );
    expect(calls[3]).toEqual(
      editOf(101, picker, {
        inline_keyboard: [
          [city('Владивосток', 'vladivostok'), city('Тбилиси', 'tbilisi')],
          [city('Ереван', 'yerevan')],
          [
            { text: '◀', callback_data: 'set:tzp:1' },
            { text: '2/2', callback_data: 'set:tzp:2' },
          ],
          ...tail,
        ],
      }),
    );

    calls.length = 0;
    await tap('set:open', 101);
    expect(calls[1]).toEqual(editOf(101, hubText(), hubKeyboard));
  });

  it('moves the local day with the zone: 450 кофе at 00:30 Moscow lands on the 30th', async () => {
    const { say, tap, calls, db, storedTimezone } = settingsBot();
    await say('100 чай', 1);
    await say('/settings', 2);
    calls.length = 0;

    await tap('set:tz:moscow', 102);
    expect(storedTimezone()).toBe('Europe/Moscow');
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-3', text: 'Часовой пояс изменён' },
      },
      editOf(102, hubText('Москва (Europe/Moscow)'), hubKeyboard),
    ]);

    await say('450 кофе', 3);
    calls.length = 0;
    await say('/today', 4);

    expect(
      db.prepare('SELECT description, occurred_on FROM expenses ORDER BY description').all(),
    ).toEqual([
      { description: 'кофе', occurred_on: '2026-09-30' },
      { description: 'чай', occurred_on: '2026-09-29' },
    ]);
    expect(sentTexts(calls)).toEqual([
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\n450.00 RSD',
    ]);
  });

  it('writes nothing for the already-selected city or a slug not in the list', async () => {
    const { say, tap, calls, totalChanges, storedTimezone } = settingsBot();
    await say('/settings', 1);
    const before = totalChanges();
    calls.length = 0;

    await tap('set:tz:belgrade', 101);
    await tap('set:tz:mars', 101);

    expect(totalChanges()).toBe(before);
    expect(storedTimezone()).toBe('Europe/Belgrade');
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: 'Этот часовой пояс уже выбран' },
      },
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-3' } },
    ]);
  });

  it('asks for any zone on [Другой…], and [Отмена] restores the hub', async () => {
    const { say, tap, calls } = settingsBot();
    await say('/settings', 1);
    calls.length = 0;

    await tap('set:tzother', 101);
    expect(calls[1]).toEqual(editOf(101, PROMPT, cancelKeyboard));

    calls.length = 0;
    await tap('flow:cancel', 101);
    expect(calls[1]).toEqual(editOf(101, hubText(), hubKeyboard));
  });

  it.each([
    ['Mars/Base', 'Такого часового пояса нет.'],
    ['+03:00', 'Такого часового пояса нет.'],
    [
      '450 кофе',
      'Похоже на трату. Сейчас я жду часовой пояс. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.',
    ],
  ])('re-asks %j and keeps the flow pending', async (text, refusal) => {
    const { say, tap, calls, db, storedTimezone } = settingsBot();
    await say('/settings', 1);
    await tap('set:tzother', 101);
    calls.length = 0;

    await say(text, 2);
    expect(calls).toEqual([editOf(101, `${refusal}\n${PROMPT}`, cancelKeyboard)]);
    expect(storedTimezone()).toBe('Europe/Belgrade');
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(0);

    // A zone off the city list shows as its IANA name.
    calls.length = 0;
    await say('europe/istanbul', 3);
    expect(storedTimezone()).toBe('Europe/Istanbul');
    expect(calls).toEqual([editOf(101, hubText('Europe/Istanbul'), hubKeyboard)]);
  });

  it('stores asia/tbilisi as Asia/Tbilisi and applies a redelivered answer once', async () => {
    const { bot, say, tap, calls, clock, storedTimezone } = settingsBot();
    await say('/settings', 1);
    await tap('set:tzother', 101);
    const answer = textUpdate({
      updateId: 50,
      messageId: 2,
      text: 'asia/tbilisi',
      date: clock.now,
    });
    calls.length = 0;

    await bot.handleUpdate(answer);
    expect(storedTimezone()).toBe('Asia/Tbilisi');
    expect(calls).toEqual([editOf(101, hubText('Тбилиси (Asia/Tbilisi)'), hubKeyboard)]);

    await tap('set:tz:moscow', 101);
    calls.length = 0;
    await bot.handleUpdate(answer);

    expect(storedTimezone()).toBe('Europe/Moscow');
    expect(calls).toEqual([]);
  });

  it('falls back to DEFAULT_TIMEZONE for a corrupt stored zone, with one warn', async () => {
    const { say, calls, db, logLines, clock } = settingsBot();
    await say('/start', 1);
    db.prepare("UPDATE users SET timezone = 'Mars/Base'").run();
    // 00:30 on the 30th in Belgrade; the 29th in UTC.
    clock.now = new Date('2026-09-29T22:30:00Z');
    logLines.length = 0;
    calls.length = 0;

    await say('/today', 2);
    expect(sentTexts(calls)).toEqual([
      '<b>Сегодня, 30 сентября — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
    ]);
    const warns = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(warns.filter((line) => line.level === 40)).toHaveLength(1);
    const userId = db.prepare('SELECT id FROM users').pluck().get();
    const warn = warns.find((line) => line.level === 40);
    expect(Object.keys(warn ?? {}).sort()).toEqual(
      ['hostname', 'level', 'msg', 'pid', 'time', 'userId'].sort(),
    );
    expect(warn).toMatchObject({ userId });

    calls.length = 0;
    await say('/settings', 3);
    expect(sentTexts(calls)).toEqual([hubText()]);
  });

  it('opens the categories screen in the anchor with a way back; /categories has none', async () => {
    const { say, tap, calls } = settingsBot();
    await say('/settings', 1);
    calls.length = 0;

    await tap('set:cat', 101);
    const categoriesText = [
      '<b>Категории «Личные расходы»</b>',
      ...CATEGORY_PRESETS.map((p) => p.name),
    ].join('\n');
    const categoriesButtons = [
      [{ text: 'Добавить', callback_data: 'cat:add' }],
      [
        { text: 'Переименовать', callback_data: 'cat:ren' },
        { text: 'Скрыть', callback_data: 'cat:arc' },
      ],
    ];
    const withBack = {
      inline_keyboard: [...categoriesButtons, [{ text: '« Назад', callback_data: 'set:open' }]],
    };
    expect(calls[1]).toEqual(editOf(101, categoriesText, withBack));

    // The back row survives a round trip through a picker, and a settings tap is stale here.
    calls.length = 0;
    await tap('cat:ren', 101);
    await tap('cat:open', 101);
    expect(calls[3]).toEqual(editOf(101, categoriesText, withBack));
    calls.length = 0;
    await tap('set:tz', 101);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-5', text: messages.staleScreen },
      },
    ]);

    calls.length = 0;
    await tap('set:open', 101);
    expect(calls[1]).toEqual(editOf(101, hubText(), hubKeyboard));

    calls.length = 0;
    await say('/categories', 2);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: categoriesText,
          reply_markup: { inline_keyboard: categoriesButtons },
          ...htmlParseMode,
        },
      },
    ]);
  });

  describe('the ledger default currency', () => {
    const picker = (currency: string) =>
      `Валюта по умолчанию для новых трат в «Личные расходы». Сейчас: ${currency}. Записанные траты не меняются.`;

    it('lists every currencies.ts code four per row, the current one marked, then back', async () => {
      const { say, tap, calls } = settingsBot();
      await say('/settings', 1);
      calls.length = 0;

      await tap('set:cur', 101);

      const buttons = CURRENCY_CODES.map((code) => ({
        text: code === 'RSD' ? '✓ RSD' : code,
        callback_data: `set:cur:${code}`,
      }));
      const rows = [];
      for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
      expect(calls[1]).toEqual(
        editOf(101, picker('RSD'), {
          inline_keyboard: [...rows, [{ text: '« Назад', callback_data: 'set:open' }]],
        }),
      );
      expect(CURRENCY_CODES).toEqual(expect.arrayContaining(['RSD', 'EUR', 'JPY', 'RUB', 'KZT']));
      for (const { callback_data } of buttons) expect(Buffer.byteLength(callback_data)).toBe(11);
    });

    it('answers a code not in the table silently and writes nothing', async () => {
      const { say, tap, calls, totalChanges } = settingsBot();
      await say('/settings', 1);
      const before = totalChanges();
      calls.length = 0;

      await tap('set:cur:XYZ', 101);

      expect(totalChanges()).toBe(before);
      expect(calls).toEqual([
        { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
      ]);
    });

    it('records the next expense in EUR and leaves the RSD rows as they were', async () => {
      const { say, tap, calls, db } = settingsBot();
      await say('100 чай', 1);
      const rsdRows = db.prepare('SELECT * FROM expenses').all();
      await say('/settings', 2);
      calls.length = 0;

      await tap('set:cur:EUR', 102);
      expect(calls).toEqual([
        {
          method: 'answerCallbackQuery',
          payload: { callback_query_id: 'cb-3', text: 'Валюта изменена' },
        },
        editOf(102, hubText('Белград (Europe/Belgrade)', 'EUR'), hubKeyboard),
      ]);

      await say('450 кофе', 3);
      calls.length = 0;
      await say('/today', 4);

      expect(
        db.prepare("SELECT amount_minor, currency FROM expenses WHERE description = 'кофе'").get(),
      ).toEqual({ amount_minor: 45000, currency: 'EUR' });
      expect(db.prepare("SELECT * FROM expenses WHERE description = 'чай'").all()).toEqual(rsdRows);
      expect(sentTexts(calls)).toEqual([
        '<b>Сегодня, 29 сентября — «Личные расходы»</b>\n100.00 RSD\n450.00 EUR',
      ]);
    });

    it('records 450 кофе as 450 JPY, and refuses 12,5 кофе in JPY', async () => {
      const { say, tap, calls, db } = settingsBot();
      await say('/settings', 1);
      await tap('set:cur:JPY', 101);
      calls.length = 0;

      await say('450 кофе', 2);
      await say('12,5 кофе', 3);

      expect(db.prepare('SELECT amount_minor, currency FROM expenses').all()).toEqual([
        { amount_minor: 450, currency: 'JPY' },
      ]);
      expect(sentTexts(calls)).toEqual([
        'Записано в «Личные расходы»: <b>450 JPY</b> — кофе · Кафе и рестораны',
        messages.invalidAmount,
      ]);
    });

    it("refuses a tap from a member who isn't the ledger's owner", async () => {
      const { say, tap, calls, db, totalChanges } = settingsBot();
      await say('/start', 1);
      // Shared ledgers have no flow yet: the membership is written directly.
      const userId = db.prepare('SELECT id FROM users').pluck().get();
      db.prepare(
        "INSERT INTO users (id, timezone, created_at) VALUES ('owner-x', 'Europe/Belgrade', ?)",
      ).run(LATE.toISOString());
      db.prepare(
        `INSERT INTO ledgers (id, kind, name, default_currency, owner_user_id, created_at)
         VALUES ('shared-x', 'shared', 'Семья', 'RSD', 'owner-x', ?)`,
      ).run(LATE.toISOString());
      db.prepare(
        "INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('shared-x', ?, 'member')",
      ).run(userId);
      db.prepare("UPDATE users SET active_ledger_id = 'shared-x' WHERE id = ?").run(userId);
      await say('/settings', 2);
      const before = totalChanges();
      calls.length = 0;

      await tap('set:cur:EUR', 102);

      expect(totalChanges()).toBe(before);
      expect(calls).toEqual([
        {
          method: 'answerCallbackQuery',
          payload: {
            callback_query_id: 'cb-3',
            text: 'Валюту «Семья» может изменить только владелец',
          },
        },
      ]);
      expect(
        db.prepare("SELECT default_currency FROM ledgers WHERE id = 'shared-x'").pluck().get(),
      ).toBe('RSD');
    });
  });
});
