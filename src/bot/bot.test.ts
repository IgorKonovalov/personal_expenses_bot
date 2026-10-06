import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Composer, type Bot, type InputFile } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBudgetLimit } from '../db/budgets.js';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { CategoryId } from '../db/categories.js';
import {
  insertExpenseOrGetExisting,
  listLedgerExpensesBetween,
  softDeleteExpense,
  type ExpenseId,
} from '../db/expenses.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import type { LedgerId } from '../db/ledgers.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import { insertReceipt, markReceiptFetched, type ReceiptId } from '../db/receipts.js';
import type { RuleId } from '../db/recurring.js';
import { findUserByIdentity, type UserId } from '../db/users.js';
import { CATEGORY_PRESETS } from '../domain/categoryPresets.js';
import { CURRENCY_CODES, toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { buildKoriscenjeSms } from '../domain/bankSms/testing/buildKoriscenjeSms.js';
import { buildRsUrl } from '../domain/receipts/testing/buildRsVl.js';
import { buildPdf } from '../domain/statements/testing/buildPdf.js';
import {
  cardRow,
  statementPdf,
  TWO_PAGE_ROWS,
} from '../domain/statements/testing/raiffeisenStatement.js';
import { monthOf, weekOf } from '../domain/periods.js';
import { tagHash, type TagName } from '../domain/tags.js';
import { TIP_KEYS } from '../domain/tips.js';
import type { LocalDate } from '../domain/time.js';
import { compareVersions } from '../domain/version.js';
import { VARIANTS } from '../fiscal/qrPixels.js';
import { createLogger } from '../logger.js';
import { register } from '../scheduler/types.js';
import { runTick } from '../scheduler/worker.js';
import { fetchDueReceipt } from '../services/fetchDueReceipt.js';
import { createLedgerKeyring, openExpenses } from '../services/ledgerKeys.js';
import { sealPersonalLedger, unlockPersonalLedger } from '../services/testing/sealLedger.js';
import { createBot, privateComposer, registerCommands } from './bot.js';
import { MENU_BAR_COMMANDS } from './handlers/menu.js';
import { MORE_BUTTONS } from './handlers/more.js';
import { startReceiptWorker } from './receiptWorker.js';
import { recurringProvider } from './recurringProvider.js';
import {
  BUDGET_CAP,
  BUDGET_CAP_CLEAR,
  BUDGET_CAPS_OPEN,
  BUDGET_LIMIT,
  BUDGET_OPEN,
  BUDGET_START_DAY,
  ONBOARDING_EDIT,
  ONBOARDING_OK,
  RECOVERY_SAVED,
  SETTINGS_ENCRYPTION,
  assertCallbackData,
  budgetCapClearData,
  budgetCapData,
  budgetCapsPageData,
  budgetScopeData,
  categoryPageData,
  categoryPickerData,
  debtDeleteData,
  editExpenseData,
  editFieldData,
  receiptItemsData,
  askData,
  receiptRetryData,
  repeatExpenseData,
  repeatScheduleData,
  restoreExpenseData,
  ruleOpenData,
  setExpenseDateData,
  setCategoryData,
  showExpenseData,
  summaryPageData,
  tagShowData,
  undoExpenseData,
} from './callbackData.js';
import { CHANGELOG_RECENT, messages } from './messages.js';
import { editHtml, html, htmlParseMode } from './render/html.js';
import {
  ADMIN_ID,
  ALLOWED_ID,
  GROUP_ID,
  SECOND_ALLOWED_ID,
  STRANGER_ID,
  callbackUpdate,
  createTestBot,
  groupTextUpdate,
  invoiceLink,
  logContent,
  myChatMemberUpdate,
  quietFirstContact,
  preCheckoutUpdate,
  successfulPaymentUpdate,
  textUpdate,
  withMessageIds,
  type ApiCall,
} from './testHarness.js';

function silentLogger() {
  return createLogger('silent');
}

const EXPENSE_ID = '00000000-0000-4000-8000-000000000003';
// The recorded card's keyboard: [Категория] [Изменить], then [Повторять], above [Удалить].
const undoKeyboard = {
  inline_keyboard: [
    [
      { text: 'Категория', callback_data: `exp:cat:${EXPENSE_ID}` },
      { text: 'Изменить', callback_data: `exp:edit:${EXPENSE_ID}` },
    ],
    [{ text: 'Повторять', callback_data: `rec:new:${EXPENSE_ID}` }],
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
    [{ text: '💰 Бюджет' }, { text: '⚙️ Настройки' }, { text: '❓ Помощь' }, { text: '☰ Ещё' }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};
const withMenu = { reply_markup: menuKeyboard, ...htmlParseMode };
const WELCOME =
  'Здравствуйте! Я веду учёт трат.' +
  '\n\nОтправьте сумму и описание, например «450 кофе», и я запишу трату. Валюту можно указать после суммы: «12,50 EUR такси».' +
  '\n\nИтоги открываются кнопками меню внизу, остальные команды — в «☰ Ещё». Подробности: /help.' +
  '\n\nВаши траты видны только вам. Выгрузить всё: /export. Как хранятся данные: /privacy.';
// The setup check's buttons.
const setupKeyboard = {
  inline_keyboard: [
    [
      { text: 'Да, всё верно', callback_data: 'onb:ok' },
      { text: 'Изменить', callback_data: 'onb:edit' },
    ],
  ],
};

function expenseCount(db: Db): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM expenses').get();
}

function sentTexts(calls: readonly ApiCall[]): unknown[] {
  return calls.map((call) => (call.payload as { text?: unknown }).text);
}

// The NBS middle rate list of 2026-09-28 (list 184), in force on the 28th.
function storeSept28Rates(db: Db) {
  const day = '2026-09-28' as LocalDate;
  const fetchedAt = new Date('2026-09-28T08:00:00Z');
  storeFxList(
    db,
    {
      listDate: day,
      listNumber: 184,
      rates: [
        { currency: 'EUR', unit: 1, middleE4: 1174993 },
        { currency: 'USD', unit: 1, middleE4: 1031782 },
        { currency: 'JPY', unit: 100, middleE4: 654009 },
      ],
    },
    fetchedAt,
  );
  setFxDay(db, day, day, fetchedAt);
}

describe('menu and help', () => {
  const NOW = new Date('2026-09-30T10:00:00Z');

  it('takes its labels from messages.menu', () => {
    expect(messages.menu).toEqual({
      today: '📊 Сегодня',
      week: '📅 Неделя',
      month: '🗓 Месяц',
      budget: '💰 Бюджет',
      settings: '⚙️ Настройки',
      help: '❓ Помощь',
      more: '☰ Ещё',
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
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          // 22:10 UTC on 29 September is 00:10 on 30 September in Belgrade.
          text: 'Проверьте настройки:\nЧасовой пояс: Белград, у вас сейчас 00:10?\nВалюта по умолчанию: RSD',
          reply_markup: setupKeyboard,
          ...htmlParseMode,
        },
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
    [
      'non-image file',
      { document: { file_id: 'd', file_unique_id: 'd', mime_type: 'application/msword' } },
    ],
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
  ])('answers a first %s with the help reply and records nothing', async (_kind, content) => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(messageUpdate(1, content));

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help, ...withMenu } },
    ]);
    expect(expenseCount(db)).toEqual({ n: 0 });
    // The only write besides provisioning: the help is now seen (ADR-0037).
    expect(db.prepare('SELECT notice FROM user_notices').pluck().all()).toEqual(['stray_help']);
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

  it('hints on the first edit of a recorded or deleted expense only, and changes nothing', async () => {
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
    expect(calls).toEqual([hint]);
    expect(db.prepare('SELECT * FROM expenses ORDER BY id').all()).toEqual(rows);
  });

  it('hints on an edit of a deleted expense', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 10, text: '450 coffee' }));
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `exp:undo:${EXPENSE_ID}` }));
    expect(db.prepare('SELECT deleted_at IS NOT NULL FROM expenses').pluck().all()).toEqual([1]);
    calls.length = 0;

    await bot.handleUpdate(editedUpdate(3, 10, '500 coffee'));

    expect(sentTexts(calls)).toEqual([messages.editedMessageHint]);
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
  it('registers the private list by default and in every private chat, the group list, then the admin commands in the admin chat', async () => {
    const { bot, calls } = createTestBot();

    await registerCommands(bot, silentLogger(), ADMIN_ID);

    expect(calls).toEqual([
      {
        method: 'setMyCommands',
        payload: {
          commands: [
            { command: 'today', description: messages.commands[0].description },
            { command: 'week', description: messages.commands[1].description },
            { command: 'month', description: messages.commands[2].description },
            { command: 'budget', description: messages.commands[3].description },
            { command: 'recurring', description: messages.commands[4].description },
            { command: 'debts', description: messages.commands[5].description },
            { command: 'tags', description: messages.commands[6].description },
            { command: 'categories', description: messages.commands[7].description },
            { command: 'export', description: messages.commands[8].description },
            { command: 'settings', description: messages.commands[9].description },
            { command: 'unlock', description: messages.commands[10].description },
            { command: 'lock', description: messages.commands[11].description },
            { command: 'help', description: messages.commands[12].description },
            { command: 'changelog', description: messages.commands[13].description },
            { command: 'donate', description: messages.commands[14].description },
            { command: 'tag', description: messages.commands[15].description },
            { command: 'privacy', description: messages.commands[16].description },
            { command: 'paysupport', description: messages.commands[17].description },
            { command: 'delete_account', description: messages.commands[18].description },
          ],
        },
      },
      {
        method: 'setMyCommands',
        payload: { commands: messages.commands, scope: { type: 'all_private_chats' } },
      },
      {
        method: 'setMyCommands',
        payload: { commands: messages.groupCommands, scope: { type: 'all_group_chats' } },
      },
      {
        method: 'setMyCommands',
        payload: {
          commands: [
            ...messages.commands,
            { command: 'invite', description: messages.adminCommands[0].description },
            { command: 'invites', description: messages.adminCommands[1].description },
            { command: 'stats', description: messages.adminCommands[2].description },
            { command: 'block', description: messages.adminCommands[3].description },
            { command: 'unblock', description: messages.adminCommands[4].description },
            { command: 'refund', description: messages.adminCommands[5].description },
          ],
          scope: { type: 'chat', chat_id: ADMIN_ID },
        },
      },
      { method: 'setMyDescription', payload: { description: messages.botDescription } },
      {
        method: 'setMyShortDescription',
        payload: { short_description: messages.botShortDescription },
      },
    ]);
  });

  it('keeps the profile texts within Telegram limits', () => {
    expect(messages.botDescription.length).toBeLessThanOrEqual(512);
    expect(messages.botShortDescription.length).toBeLessThanOrEqual(120);
    expect(messages.botDescription).toContain('«450 кофе»');
  });

  it('still sets the commands when setMyDescription fails', async () => {
    const { bot, calls } = createTestBot();
    bot.api.config.use((prev, method, payload, signal) =>
      method === 'setMyDescription'
        ? Promise.reject(new Error('network down'))
        : prev(method, payload, signal),
    );
    const lines: string[] = [];

    await registerCommands(
      bot,
      createLogger('info', { write: (line: string) => void lines.push(line) }),
      ADMIN_ID,
    );

    expect(calls.map((c) => c.method)).toEqual([
      'setMyCommands',
      'setMyCommands',
      'setMyCommands',
      'setMyCommands',
    ]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 40,
      msg: 'setMyDescription failed',
    });
  });

  it('logs a warning per failed step and returns when every call fails', async () => {
    const { bot } = createTestBot();
    bot.api.config.use(() => Promise.reject(new Error('network down')));
    const lines: string[] = [];

    await registerCommands(
      bot,
      createLogger('info', { write: (line: string) => void lines.push(line) }),
      ADMIN_ID,
    );

    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual([
      'setMyCommands failed',
      'setMyCommands failed for the admin chat',
      'setMyDescription failed',
    ]);
  });

  it('still writes the group list and the profile texts when the admin-chat scope fails', async () => {
    const { bot, calls } = createTestBot();
    bot.api.config.use((prev, method, payload, signal) => {
      const scope = (payload as { scope?: { type: string } } | undefined)?.scope;
      return method === 'setMyCommands' && scope?.type === 'chat'
        ? Promise.reject(new Error('Bad Request: chat not found'))
        : prev(method, payload, signal);
    });
    const lines: string[] = [];

    await registerCommands(
      bot,
      createLogger('info', { write: (line: string) => void lines.push(line) }),
      ADMIN_ID,
    );

    expect(calls).toContainEqual({
      method: 'setMyCommands',
      payload: { commands: messages.groupCommands, scope: { type: 'all_group_chats' } },
    });
    expect(calls.map((c) => c.method)).toEqual([
      'setMyCommands',
      'setMyCommands',
      'setMyCommands',
      'setMyDescription',
      'setMyShortDescription',
    ]);
    expect(lines.map((l) => JSON.parse(l) as { level: number; msg: string })).toEqual([
      expect.objectContaining({ level: 40, msg: 'setMyCommands failed for the admin chat' }),
    ]);
  });
});

describe('/changelog', () => {
  const OLDER =
    '\n\nБолее ранние версии: <a href="https://github.com/IgorKonovalov/personal_expenses_bot/blob/main/CHANGELOG.md">CHANGELOG.md</a>';

  it('lists the five newest announced versions, newest first, then links the rest', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/changelog' }));

    // Derived from the live map, so a close that adds the next version's entry keeps this green.
    const newestFirst = Object.keys(messages.versionAnnouncements).sort((x, y) =>
      compareVersions(y, x),
    );
    expect(newestFirst.length).toBeGreaterThan(CHANGELOG_RECENT);
    const sections = newestFirst
      .slice(0, 5)
      .map((v) => `<b>${v}</b>\n${String(messages.versionAnnouncements[v])}`);
    const text = `<b>Что нового</b>\n\n${sections.join('\n\n')}${OLDER}`;
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text,
          link_preview_options: { is_disabled: true },
          ...htmlParseMode,
        },
      },
    ]);
    expect(text).not.toContain(`<b>${String(newestFirst[5])}</b>`);
    expect(text.length).toBeLessThan(4096);
  });

  it('sorts by version number, not by insertion order', () => {
    const text = messages.changelog({ '0.9.0': html`девять`, '0.10.0': html`десять` });

    expect(text).toBe('<b>Что нового</b>\n\n<b>0.10.0</b>\nдесять\n\n<b>0.9.0</b>\nдевять');
  });

  it('shows 0.39.0 down to 0.35.0 of forty versions, and the link', () => {
    const announcements = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`0.${String(i)}.0`, html`версия ${i}`]),
    );

    const text = messages.changelog(announcements);

    expect(text).toBe(
      `<b>Что нового</b>\n\n${[39, 38, 37, 36, 35]
        .map((i) => `<b>0.${String(i)}.0</b>\nверсия ${String(i)}`)
        .join('\n\n')}${OLDER}`,
    );
  });

  it('has no link line when every version fits in the five', () => {
    const announcements = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`0.${String(i)}.0`, html`версия ${i}`]),
    );

    expect(messages.changelog(announcements)).not.toContain('Более ранние версии');
  });

  it('is in the command menu and the help text', () => {
    expect(messages.commands.map((c) => c.command)).toContain('changelog');
    expect(messages.help).toContain('/changelog');
  });

  it('answers a user who is not admitted with the invitation reply only', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, fromId: STRANGER_ID, text: '/changelog' }));

    expect(calls).toMatchObject([
      { method: 'sendMessage', payload: { chat_id: STRANGER_ID, text: messages.invitationOnly } },
    ]);
  });
});

describe('donations (ADR-0027)', () => {
  function donationRows(db: Db): unknown[] {
    return db
      .prepare('SELECT user_id, stars, telegram_payment_charge_id, refunded_at FROM donations')
      .all();
  }

  function userIdOf(db: Db, telegramId: number): unknown {
    return db
      .prepare('SELECT user_id FROM auth_identities WHERE external_id = ?')
      .pluck()
      .get(String(telegramId));
  }

  const starsKeyboard = [
    [
      { text: '⭐ 50', url: invoiceLink('donate:50') },
      { text: '⭐ 150', url: invoiceLink('donate:150') },
      { text: '⭐ 500', url: invoiceLink('donate:500') },
    ],
  ];

  it('creates one XTR invoice link per preset at boot, with an empty provider token', async () => {
    const { calls, prepareDonations } = createTestBot();

    await prepareDonations();

    expect(calls).toEqual(
      [50, 150, 500].map((stars) => ({
        method: 'createInvoiceLink',
        payload: {
          title: messages.donateInvoiceTitle,
          description: messages.donateInvoiceDescription,
          payload: `donate:${String(stars)}`,
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: messages.donateInvoiceLabel, amount: stars }],
        },
      })),
    );
  });

  it('answers /donate with the text and one URL button per cached link', async () => {
    const { bot, calls, prepareDonations } = createTestBot();
    await prepareDonations();
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/donate' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: messages.donate,
          reply_markup: { inline_keyboard: starsKeyboard },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('answers donateUnavailable when every link creation failed and logs each at warn', async () => {
    const { bot, calls, logLines, prepareDonations } = createTestBot({
      logLevel: 'info',
      failMethods: ['createInvoiceLink'],
    });
    await prepareDonations();
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/donate' }));

    expect(sentTexts(calls)).toEqual([messages.donateUnavailable]);
    expect(
      logLines
        .filter((line) => line.includes('createInvoiceLink failed'))
        .map((line) => {
          const { level, stars } = JSON.parse(line) as { level: number; stars: number };
          return { level, stars };
        }),
    ).toEqual([
      { level: 40, stars: 50 },
      { level: 40, stars: 150 },
      { level: 40, stars: 500 },
    ]);
  });

  it('gets no reply to /donate in a bound group', async () => {
    const { bot, calls, prepareDonations } = createTestBot();
    await prepareDonations();
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 1,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    calls.length = 0;

    await bot.handleUpdate(groupTextUpdate({ updateId: 2, text: '/donate' }));

    expect(calls).toEqual([]);
  });

  it('is in the private command menu and not in the group one', () => {
    expect(messages.commands.map((c) => c.command)).toContain('donate');
    expect(messages.groupCommands.map((c) => c.command)).not.toContain('donate');
  });

  it.each([
    ['XTR', 150, 'donate:150', true],
    ['XTR', 50, 'donate:150', false],
    ['USD', 150, 'donate:150', false],
  ] as const)(
    'answers a pre-checkout of %s, %d, %s with ok %s',
    async (currency, totalAmount, payload, ok) => {
      const { bot, calls, db } = createTestBot();

      await bot.handleUpdate(preCheckoutUpdate({ updateId: 1, currency, totalAmount, payload }));

      expect(calls).toEqual([
        {
          method: 'answerPreCheckoutQuery',
          payload: ok
            ? { pre_checkout_query_id: 'pcq-1', ok: true }
            : { pre_checkout_query_id: 'pcq-1', ok: false, error_message: messages.donateRejected },
        },
      ]);
      expect(donationRows(db)).toEqual([]);
    },
  );

  it('does not answer a pre-checkout from a user outside the allow-list', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(
      preCheckoutUpdate({
        updateId: 1,
        currency: 'XTR',
        totalAmount: 150,
        payload: 'donate:150',
        fromId: STRANGER_ID,
      }),
    );

    expect(calls).toEqual([]);
  });

  it('records, thanks and notifies the admin once when the update is delivered twice', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start', fromId: SECOND_ALLOWED_ID }));
    calls.length = 0;

    const payment = successfulPaymentUpdate({
      updateId: 2,
      stars: 150,
      chargeId: 'charge-1',
      fromId: SECOND_ALLOWED_ID,
    });
    await bot.handleUpdate(payment);
    await bot.handleUpdate(payment);

    const userId = userIdOf(db, SECOND_ALLOWED_ID);
    expect(donationRows(db)).toEqual([
      { user_id: userId, stars: 150, telegram_payment_charge_id: 'charge-1', refunded_at: null },
    ]);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: SECOND_ALLOWED_ID, text: messages.donateThanks, ...htmlParseMode },
      },
      {
        method: 'sendMessage',
        payload: {
          chat_id: ADMIN_ID,
          text: `⭐ Пожертвование: 150 Stars\nПользователь: <code>${String(userId)}</code>\nПлатёж: <code>charge-1</code>`,
          ...htmlParseMode,
        },
      },
    ]);
    // No Telegram name in the notice.
    expect(sentTexts(calls)[1]).not.toContain('Test');
  });

  it('still thanks the donor when the admin notice is refused', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start', fromId: SECOND_ALLOWED_ID }));
    bot.api.config.use((prev, method, payload, signal) =>
      method === 'sendMessage' && (payload as { chat_id: number }).chat_id === ADMIN_ID
        ? Promise.reject(new Error('Forbidden: bot was blocked by the user'))
        : prev(method, payload, signal),
    );
    calls.length = 0;

    await bot.handleUpdate(
      successfulPaymentUpdate({
        updateId: 2,
        stars: 50,
        chargeId: 'charge-2',
        fromId: SECOND_ALLOWED_ID,
      }),
    );

    expect(sentTexts(calls)).toEqual([messages.donateThanks]);
    expect(donationRows(db)).toHaveLength(1);
  });

  it('adds a last [Ko-fi] URL button when DONATE_URL is set', async () => {
    const { bot, calls, prepareDonations } = createTestBot({
      donateUrl: 'https://ko-fi.com/example',
    });
    await prepareDonations();
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/donate' }));

    const markup = (calls[0]?.payload as { reply_markup: { inline_keyboard: unknown[][] } })
      .reply_markup;
    const buttons = markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(4);
    expect(buttons[3]).toEqual({ text: messages.donateExternal, url: 'https://ko-fi.com/example' });
    expect(markup.inline_keyboard).toEqual([
      ...starsKeyboard,
      [{ text: 'Ko-fi', url: 'https://ko-fi.com/example' }],
    ]);
  });

  it('has three buttons without DONATE_URL', async () => {
    const { bot, calls, prepareDonations } = createTestBot();
    await prepareDonations();
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/donate' }));

    const markup = (calls[0]?.payload as { reply_markup: { inline_keyboard: unknown[][] } })
      .reply_markup;
    expect(markup.inline_keyboard.flat()).toHaveLength(3);
  });

  it('shows only [Ko-fi] when every link creation failed and DONATE_URL is set', async () => {
    const { bot, calls, prepareDonations } = createTestBot({
      donateUrl: 'https://ko-fi.com/example',
      failMethods: ['createInvoiceLink'],
    });
    await prepareDonations();
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/donate' }));

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: messages.donate,
          reply_markup: {
            inline_keyboard: [[{ text: 'Ko-fi', url: 'https://ko-fi.com/example' }]],
          },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('ends the private /help with the donate line, and keeps /donate out of the group help', async () => {
    const { bot, calls } = createTestBot();
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 1,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/help' }));
    await bot.handleUpdate(groupTextUpdate({ updateId: 3, text: '/help' }));

    const [privateHelp, groupHelp] = sentTexts(calls);
    expect(String(privateHelp).endsWith('\nБот бесплатный. Поддержать: /donate')).toBe(true);
    expect(messages.helpDonateLine).toBe('Бот бесплатный. Поддержать: /donate');
    expect(groupHelp).toBe(messages.groupHelp);
    expect(String(groupHelp)).not.toContain('/donate');
  });

  it('records a payment from a user the access middleware would refuse', async () => {
    const { bot, db } = createTestBot();
    // A user admitted earlier and dropped from the allow-list since the pre-checkout.
    db.prepare("INSERT INTO users (id, timezone, created_at) VALUES ('u-gone', 'UTC', 'x')").run();
    db.prepare(
      "INSERT INTO auth_identities (provider, external_id, user_id) VALUES ('telegram', ?, 'u-gone')",
    ).run(String(STRANGER_ID));

    await bot.handleUpdate(
      successfulPaymentUpdate({
        updateId: 1,
        stars: 50,
        chargeId: 'charge-9',
        fromId: STRANGER_ID,
      }),
    );

    expect(donationRows(db)).toEqual([
      { user_id: 'u-gone', stars: 50, telegram_payment_charge_id: 'charge-9', refunded_at: null },
    ]);
  });

  it('thanks a payer with no user, records nothing and logs the charge id at warn', async () => {
    const { bot, calls, db, logLines } = createTestBot({ logLevel: 'info' });

    await bot.handleUpdate(
      successfulPaymentUpdate({
        updateId: 1,
        stars: 50,
        chargeId: 'charge-7',
        fromId: STRANGER_ID,
      }),
    );

    expect(donationRows(db)).toEqual([]);
    expect(sentTexts(calls)).toEqual([messages.donateThanks]);
    expect(
      logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((l) => l.level === 40),
    ).toMatchObject([{ chargeId: 'charge-7' }]);
  });
});

describe('/paysupport and /refund', () => {
  // SECOND_ALLOWED_ID donates 50 (charge-a) and then 150 (charge-b); ADMIN_ID is the admin.
  async function withTwoDonations(options: { failMethods?: readonly string[] } = {}) {
    const harness = createTestBot(options);
    const { bot, calls } = harness;
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start', fromId: SECOND_ALLOWED_ID }));
    for (const [i, [stars, chargeId]] of [
      [50, 'charge-a'],
      [150, 'charge-b'],
    ].entries()) {
      await bot.handleUpdate(
        successfulPaymentUpdate({
          updateId: 2 + i,
          stars: Number(stars),
          chargeId: String(chargeId),
          fromId: SECOND_ALLOWED_ID,
        }),
      );
    }
    calls.length = 0;
    return harness;
  }

  function refundedAt(db: Db, chargeId: string): unknown {
    return db
      .prepare('SELECT refunded_at FROM donations WHERE telegram_payment_charge_id = ?')
      .pluck()
      .get(chargeId);
  }

  function refundCalls(calls: readonly ApiCall[]): unknown[] {
    return calls.filter((c) => c.method === 'refundStarPayment').map((c) => c.payload);
  }

  // The texts of the messages sent, leaving out the refundStarPayment call.
  function replies(calls: readonly ApiCall[]): unknown[] {
    return sentTexts(calls.filter((c) => c.method === 'sendMessage'));
  }

  it('explains, with no text, that a donation unlocks nothing and how to ask for a refund', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(
      textUpdate({ updateId: 1, text: '/paysupport', fromId: SECOND_ALLOWED_ID }),
    );

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: SECOND_ALLOWED_ID, text: messages.paySupport, ...htmlParseMode },
      },
    ]);
    expect(messages.paySupport).toContain('ничего не открывает');
    expect(messages.paySupport).toContain('/paysupport');
  });

  it('relays the request with both charge ids to the admin once and confirms to the user', async () => {
    const { bot, calls, db } = await withTwoDonations();

    await bot.handleUpdate(
      textUpdate({
        updateId: 10,
        text: '/paysupport верните пожалуйста',
        fromId: SECOND_ALLOWED_ID,
      }),
    );

    const userId = String(
      db.prepare("SELECT user_id FROM auth_identities WHERE external_id = '1003'").pluck().get(),
    );
    // The harness clock is 2026-09-29T22:10Z: already the 30th in the admin's default zone.
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ADMIN_ID,
          text:
            `💬 /paysupport от <code>${userId}</code>\n\nверните пожалуйста\n\nПожертвования:\n` +
            '<code>charge-b</code> · 150 Stars · 30 сентября 2026\n' +
            '<code>charge-a</code> · 50 Stars · 30 сентября 2026',
          ...htmlParseMode,
        },
      },
      {
        method: 'sendMessage',
        payload: { chat_id: SECOND_ALLOWED_ID, text: messages.paySupportSent, ...htmlParseMode },
      },
    ]);
  });

  it('caps the relayed donations at the ten newest', async () => {
    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start', fromId: SECOND_ALLOWED_ID }));
    for (let i = 0; i < 12; i++) {
      await bot.handleUpdate(
        successfulPaymentUpdate({
          updateId: 2 + i,
          stars: 50,
          chargeId: `charge-${String(i).padStart(2, '0')}`,
          fromId: SECOND_ALLOWED_ID,
        }),
      );
    }
    calls.length = 0;

    await bot.handleUpdate(
      textUpdate({ updateId: 20, text: '/paysupport вопрос', fromId: SECOND_ALLOWED_ID }),
    );

    const relayed = String(sentTexts(calls)[0]);
    expect(relayed.match(/<code>charge-/g)).toHaveLength(10);
    expect(relayed).toContain('charge-11');
    expect(relayed).not.toContain('charge-01');
    expect(relayed).not.toContain('charge-00');
  });

  it('refunds once with the payer’s Telegram id, then answers already-refunded without Telegram', async () => {
    const { bot, calls, db } = await withTwoDonations();

    await bot.handleUpdate(textUpdate({ updateId: 10, text: '/refund charge-a' }));

    expect(refundCalls(calls)).toEqual([
      { user_id: SECOND_ALLOWED_ID, telegram_payment_charge_id: 'charge-a' },
    ]);
    expect(refundedAt(db, 'charge-a')).toBe('2026-09-29T22:10:00.000Z');
    expect(refundedAt(db, 'charge-b')).toBeNull();
    expect(replies(calls)).toEqual([messages.refundDone(50)]);
    expect(messages.refundDone(50)).toBe('Возвращено: 50 Stars.');
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 11, text: '/refund charge-a' }));

    expect(refundCalls(calls)).toEqual([]);
    expect(sentTexts(calls)).toEqual([messages.refundAlreadyRefunded]);
  });

  it('answers not-found for an unknown charge id', async () => {
    const { bot, calls } = await withTwoDonations();

    await bot.handleUpdate(textUpdate({ updateId: 10, text: '/refund charge-x' }));

    expect(refundCalls(calls)).toEqual([]);
    expect(sentTexts(calls)).toEqual([messages.refundNotFound]);
  });

  it('leaves refunded_at NULL and reports a refundStarPayment error to the admin', async () => {
    const { bot, calls, db } = await withTwoDonations({ failMethods: ['refundStarPayment'] });

    await bot.handleUpdate(textUpdate({ updateId: 10, text: '/refund charge-b' }));

    expect(refundCalls(calls)).toHaveLength(1);
    expect(refundedAt(db, 'charge-b')).toBeNull();
    const [reply] = replies(calls);
    expect(String(reply)).toMatch(/^Telegram не вернул Stars: .*Bad Request: test/);
    expect(calls.at(-1)?.payload).toMatchObject({ chat_id: ADMIN_ID });
  });

  it('treats a non-admin’s /refund as an unknown command', async () => {
    const { bot, calls, db } = await withTwoDonations();

    await bot.handleUpdate(
      textUpdate({ updateId: 10, text: '/refund charge-a', fromId: SECOND_ALLOWED_ID }),
    );

    expect(refundCalls(calls)).toEqual([]);
    expect(refundedAt(db, 'charge-a')).toBeNull();
    expect(sentTexts(calls)).toEqual([messages.help]);
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
            { text: 'Метки', callback_data: `exp:ef:${ID}:g` },
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

  it('answers a description typed after the flow expired with the kind-neutral flowExpired', async () => {
    const { say, calls, db } = await prompting('d');
    const before = row(db);
    db.prepare('UPDATE flow_sessions SET expires_at = ?').run('2026-09-30T09:59:00.000Z');

    await say('капучино', 11);

    expect(sentTexts(calls)).toEqual(['Время ответа истекло. Начните заново.']);
    expect(row(db)).toEqual(before);
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
    const { tap, say, calls, db } = await recorded();
    await tap(`exp:edit:${ID}`);
    calls.length = 0;
    await tap(`exp:ef:${ID}:d`);
    expect(calls[1]).toEqual(
      cardEdit('Сейчас: кофе. Введите новое описание.', { inline_keyboard: [cancelRow] }),
    );
    calls.length = 0;
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

describe('/budget and the card line (ADR-0017)', () => {
  // 2026-10-01 12:00 in Belgrade: day 1 of a 31-day October.
  const OCT_1 = new Date('2026-10-01T10:00:00Z');
  const botInfo = createTestBot().bot.botInfo;

  function budgetBot() {
    const clock = { now: OCT_1 };
    const db = openDatabase(':memory:');
    runMigrations(db, OCT_1);
    quietFirstContact(db);
    let ids = 0;
    let messageId = 100;
    const bot = createBot({
      token: '123456:test-token',
      adminTelegramId: ALLOWED_ID,
      backupKeep: 14,
      logger: silentLogger(),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => clock.now,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      keys: createLedgerKeyring(() => clock.now),
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

  const lastText = (calls: readonly ApiCall[]) => sentTexts(calls).at(-1);

  // /budget (anchor 101), [Задать лимит], then the limit typed.
  async function withLimit(limit = '30000') {
    const harness = budgetBot();
    await harness.say('/budget', 1);
    await harness.tap('bud:lim', 101);
    await harness.say(limit, 2);
    harness.calls.length = 0;
    return harness;
  }

  it.each(['/budget', '💰 Бюджет'])('opens the screen with no limit on %j', async (text) => {
    const { say, calls } = budgetBot();

    await say(text, 1);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text:
            '<b>Бюджет «Личные расходы»</b>\nЛимит не задан. Задайте лимит на период, и после ' +
            'каждой траты я покажу, сколько осталось на сегодня.',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Задать лимит', callback_data: 'bud:lim' }],
              [{ text: 'День начала периода', callback_data: 'bud:day' }],
              [
                { text: '✓ Считать все', callback_data: 'bud:scope:a' },
                { text: 'Только необязательные', callback_data: 'bud:scope:o' },
              ],
              [{ text: 'Лимиты по категориям', callback_data: 'bud:caps' }],
            ],
          },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('asks for the limit in the anchor, stores 30000 and shows the screen with it', async () => {
    const { say, tap, calls, db } = budgetBot();
    await say('/budget', 1);
    calls.length = 0;

    await tap('bud:lim', 101);
    expect(lastText(calls)).toBe('Лимит на период в RSD. Отправьте сумму, например «30 000».');

    await say('30000', 2);
    expect(db.prepare('SELECT limit_minor, currency FROM ledger_budgets').get()).toEqual({
      limit_minor: 3_000_000,
      currency: 'RSD',
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: {
        message_id: 101,
        text: [
          '<b>Бюджет «Личные расходы»</b>',
          'Период: 1–31 октября, день 1 из 31',
          'Считаются все траты.',
          'Лимит: 30 000.00 RSD, потрачено 0.00 RSD',
          'Осталось на сегодня: 967.74 RSD',
          'Осталось до 31 окт: 30 000.00 RSD',
        ].join('\n'),
      },
    });
  });

  it('re-asks 450 кофе in the limit prompt and records nothing', async () => {
    const { say, tap, calls, db } = budgetBot();
    await say('/budget', 1);
    await tap('bud:lim', 101);

    await say('450 кофе', 2);

    expect(lastText(calls)).toBe(
      'Похоже на трату. Сейчас я жду лимит. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.\n' +
        'Лимит на период в RSD. Отправьте сумму, например «30 000».',
    );
    expect(expenseCount(db)).toEqual({ n: 0 });
  });

  it("adds what's left for today and the period under 450 кофе's card", async () => {
    const { say, calls } = await withLimit();

    await say('450 кофе', 3);

    expect(lastText(calls)).toBe(
      'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны\n' +
        'Осталось на сегодня: 517.74 RSD · до 31 окт: 29 550.00 RSD',
    );
  });

  it('leaves the period remainder at 29 550.00 when 450 кофе is redelivered', async () => {
    const { bot, calls, db } = await withLimit();
    const update = textUpdate({ updateId: 50, messageId: 3, text: '450 кофе', date: OCT_1 });

    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
    expect(String(lastText(calls))).toContain('до 31 окт: 29 550.00 RSD');
  });

  it('shows overspend as copy, not a negative amount', async () => {
    const { say, calls } = await withLimit();

    await say('1500 ресторан', 3);

    const text = String(lastText(calls));
    expect(text).toContain('\nСегодня перерасход 532.26 RSD · до 31 окт: 28 500.00 RSD');
    expect(text).not.toContain('-532');
  });

  it('drops the line from the deleted card and brings it back on restore', async () => {
    const { say, tap, calls, db } = await withLimit();
    await say('450 кофе', 3);
    const id = db.prepare('SELECT id FROM expenses').pluck().get() as ExpenseId;

    await tap(undoExpenseData(id), 104);
    expect(lastText(calls)).toBe('Удалено из «Личные расходы»: <b>450.00 RSD</b> — кофе');

    await tap(restoreExpenseData(id), 104);
    expect(String(lastText(calls))).toContain(
      'Осталось на сегодня: 517.74 RSD · до 31 окт: 29 550.00 RSD',
    );
  });

  it('moves the period to start on the 10th, and the card names its last day', async () => {
    const { say, tap, calls, db } = await withLimit();
    await say('/budget', 3);

    await tap('bud:day', 102);
    expect(lastText(calls)).toBe(
      'Сейчас период начинается 1-го числа. Отправьте день месяца от 1 до 31, например «10» — ' +
        'день зарплаты. Если в месяце нет такого дня, период начнётся в последний день месяца.',
    );
    await say('32', 4);
    expect(String(lastText(calls))).toMatch(/^Нужен день месяца от 1 до 31\.\n/);
    await say('10', 5);

    expect(db.prepare('SELECT period_start_day FROM ledger_budgets').pluck().get()).toBe(10);
    expect(String(lastText(calls))).toContain('Период: 10 сентября – 9 октября, день 22 из 30');
    await say('450 кофе', 6);
    expect(String(lastText(calls))).toContain('· до 9 окт: ');
  });

  it('sets the optional-only scope once on a double tap', async () => {
    const { say, tap, calls, db } = await withLimit();
    await say('/budget', 3);
    calls.length = 0;

    await tap('bud:scope:o', 102);
    await tap('bud:scope:o', 102);

    expect(db.prepare('SELECT scope FROM ledger_budgets').pluck().get()).toBe('optional');
    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(String(sentTexts(edits)[0])).toContain('Считаются только необязательные траты.');
    expect(calls.at(-1)).toEqual({
      method: 'answerCallbackQuery',
      payload: { callback_query_id: 'cb-6', text: 'Уже выбрано' },
    });
  });

  it('caps Кафе и рестораны at 5000: the over-cap card uses the overspend copy, такси has no line', async () => {
    const { say, tap, calls, db } = await withLimit();
    const cafe = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'cafe'")
      .pluck()
      .get() as number;
    await say('/budget', 3);
    await tap('bud:caps', 102);
    await tap(`bud:cap:${String(cafe)}`, 102);
    expect(lastText(calls)).toBe(
      'Лимит на период для «Кафе и рестораны» в RSD. Отправьте сумму, например «5 000».',
    );
    await say('5000', 4);

    await say('450 кофе', 5);
    expect(String(lastText(calls))).toMatch(/\nКафе и рестораны: 450\.00 из 5 000\.00 RSD$/);
    await say('4800 ресторан', 6);
    expect(String(lastText(calls))).toMatch(
      /\nКафе и рестораны: 5 250\.00 из 5 000\.00 RSD, перерасход 250\.00 RSD$/,
    );
    await say('300 такси', 7);
    expect(String(lastText(calls))).not.toContain(' из ');

    await say('/budget', 8);
    expect(String(lastText(calls))).toContain(
      '<b>По категориям</b>\nКафе и рестораны: 5 250.00 из 5 000.00 RSD, перерасход 250.00 RSD',
    );
  });

  it('offers [« Назад] on the cap prompt, which cancels the cap flow and shows the cap list', async () => {
    const { say, tap, calls, db } = await withLimit();
    const cafe = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'cafe'")
      .pluck()
      .get() as number;
    await say('/budget', 3);
    await tap(`bud:cap:${String(cafe)}`, 102);
    await say('5000', 4);

    await tap(`bud:cap:${String(cafe)}`, 102);
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Убрать лимит', callback_data: `bud:capx:${String(cafe)}` }],
            [{ text: '« Назад', callback_data: 'bud:caps' }],
            [{ text: 'Отмена', callback_data: 'flow:cancel' }],
          ],
        },
      },
    });

    await tap('bud:caps', 102);
    expect(lastText(calls)).toBe(
      'Лимит на период для категории. Выберите категорию, чтобы задать или убрать лимит.',
    );
    expect(db.prepare('SELECT kind FROM flow_sessions').pluck().get()).toBeNull();
    await say('6000', 5);
    expect(db.prepare('SELECT cap_minor FROM category_caps').pluck().all()).toEqual([500_000]);
  });

  it('says the RUB caps were dropped when the limit is set again in EUR', async () => {
    const { say, tap, calls, db } = budgetBot();
    await say('/settings', 1);
    await tap('set:cur:RUB', 101);
    const cafe = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'cafe'")
      .pluck()
      .get() as number;
    await say('/budget', 2);
    await tap('bud:lim', 102);
    await say('30000', 3);
    await say('/budget', 4);
    await tap(`bud:cap:${String(cafe)}`, 103);
    await say('5000', 5);
    expect(db.prepare('SELECT cap_minor FROM category_caps').pluck().all()).toEqual([500_000]);

    await say('/settings', 6);
    await tap('set:cur:EUR', 104);
    await say('/budget', 7);
    await tap('bud:lim', 105);
    await say('1000', 8);

    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: { message_id: 105 },
    });
    expect(String(lastText(calls))).toMatch(
      /^Лимиты по категориям сброшены: они были в RUB\.\n\n<b>Бюджет «Личные расходы»<\/b>\n/,
    );
    expect(db.prepare('SELECT COUNT(*) FROM category_caps').pluck().get()).toBe(0);
  });

  it("neither lists an archived category's cap nor puts it on the card", async () => {
    const { say, tap, calls, db } = await withLimit();
    const cafe = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'cafe'")
      .pluck()
      .get() as number;
    await say('/budget', 3);
    await tap(`bud:cap:${String(cafe)}`, 102);
    await say('5000', 4);
    await say('450 кофе', 5);
    db.prepare("UPDATE categories SET archived_at = '2026-10-01T10:00:00.000Z' WHERE id = ?").run(
      cafe,
    );

    await say('/budget', 6);
    expect(String(lastText(calls))).not.toContain('По категориям');
    const id = db.prepare('SELECT id FROM expenses').pluck().get() as ExpenseId;
    await tap(undoExpenseData(id), 104);
    await tap(restoreExpenseData(id), 104);
    expect(String(lastText(calls))).not.toContain(' из ');
  });

  it('builds every bud:* callback_data within 64 bytes at the largest id and page', () => {
    // The largest id a number holds exactly: 16 digits, the most the \d{1,16} patterns admit.
    const id = Number.MAX_SAFE_INTEGER as CategoryId;
    for (const data of [
      BUDGET_OPEN,
      BUDGET_LIMIT,
      BUDGET_START_DAY,
      BUDGET_CAPS_OPEN,
      budgetScopeData('all'),
      budgetScopeData('optional'),
      budgetCapsPageData(9999),
      budgetCapData(id),
      budgetCapClearData(id),
    ]) {
      expect(assertCallbackData(data)).toBe(data);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
    expect(budgetCapData(id)).toMatch(BUDGET_CAP);
    expect(budgetCapClearData(id)).toMatch(BUDGET_CAP_CLEAR);
  });

  // A 30 000.00 RSD budget over September (start day 1), set on the 28th: day 28 of 30, with
  // the 28th's NBS rates stored. /budget is message 101.
  async function sept28Budget() {
    const harness = budgetBot();
    harness.clock.now = new Date('2026-09-28T08:00:00Z');
    storeSept28Rates(harness.db);
    await harness.say('/budget', 1);
    await harness.tap('bud:lim', 101);
    await harness.say('30000', 2);
    harness.calls.length = 0;
    return harness;
  }

  it('counts a 6.00 USD expense converted on its card: 27 380.93 today, 29 380.93 to 30 сен', async () => {
    const { say, calls } = await sept28Budget();

    await say('6 USD подписка', 3);

    // floor(3 000 000 * 28 / 30) = 2 800 000, minus 61 907.
    expect(String(lastText(calls))).toContain(
      '\nОсталось на сегодня: 27 380.93 RSD · до 30 сен: 29 380.93 RSD',
    );

    await say('/budget', 4);
    const screen = String(lastText(calls));
    expect(screen).toContain('Лимит: 30 000.00 RSD, потрачено 619.07 RSD');
    expect(screen).toContain(
      '\nОсталось до 30 сен: 29 380.93 RSD\nТраты в других валютах пересчитаны по курсу НБС на день траты.',
    );
  });

  it('shows Другое: 619.07 из 1 000.00 RSD for a 6.00 USD expense under a 1 000.00 cap', async () => {
    const { say, tap, calls, db } = await sept28Budget();
    const other = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'other'")
      .pluck()
      .get() as number;
    await say('/budget', 3);
    await tap(`bud:cap:${String(other)}`, 102);
    await say('1000', 4);
    await say('6 USD подписка', 5);

    expect(db.prepare('SELECT category_id FROM expenses').pluck().get()).toBe(other);
    expect(String(lastText(calls))).toMatch(/\nДругое: 619\.07 из 1 000\.00 RSD$/);
  });

  it('lists 5 000.00 KZT as not counted, with no rate, and the figures stay put', async () => {
    const { say, calls } = await sept28Budget();
    await say('6 USD подписка', 3);
    await say('5000 KZT сувенир', 4);

    await say('/budget', 5);

    const screen = String(lastText(calls));
    expect(screen).toContain('Лимит: 30 000.00 RSD, потрачено 619.07 RSD');
    expect(screen).toContain('Осталось на сегодня: 27 380.93 RSD');
    expect(screen).toContain('\nНе учтено, нет курса: 5 000.00 KZT');
  });

  it('counts 450.00 RSD as 3.83 EUR in a EUR budget on an RSD ledger', async () => {
    const { say, tap, calls, clock, db } = budgetBot();
    clock.now = new Date('2026-09-28T08:00:00Z');
    storeSept28Rates(db);
    await say('/settings', 1);
    await tap('set:cur:EUR', 101);
    await say('/budget', 2);
    await tap('bud:lim', 102);
    await say('1000', 3);
    await say('/settings', 4);
    await tap('set:cur:RSD', 103);
    await say('450 кофе', 5);

    await say('/budget', 6);

    expect(String(lastText(calls))).toContain('Лимит: 1 000.00 EUR, потрачено 3.83 EUR');
  });

  it('renders a budget with only RSD expenses as before, with no conversion line', async () => {
    const { say, calls } = await withLimit();
    await say('450 кофе', 3);

    await say('/budget', 4);

    expect(lastText(calls)).toBe(
      [
        '<b>Бюджет «Личные расходы»</b>',
        'Период: 1–31 октября, день 1 из 31',
        'Считаются все траты.',
        'Лимит: 30 000.00 RSD, потрачено 450.00 RSD',
        'Осталось на сегодня: 517.74 RSD',
        'Осталось до 31 окт: 29 550.00 RSD',
      ].join('\n'),
    );
  });

  it('lists an EUR expense as not counted on the screen', async () => {
    const { say, calls } = await withLimit();
    await say('12,50 EUR такси', 3);

    await say('/budget', 4);

    expect(String(lastText(calls))).toContain('\nНе учтено, нет курса: 12.50 EUR');
    expect(String(lastText(calls))).toContain('Осталось до 31 окт: 30 000.00 RSD');
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
          text:
            '<b>Сегодня, 30 сентября — «Личные расходы»</b>\n462.50 RSD\n12.50 EUR\n\n' +
            'Без курса НБС, не пересчитано: EUR.',
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('converts the day into one RSD total at the NBS rate, with the note', async () => {
    const sept28 = new Date('2026-09-28T08:00:00Z');
    const { bot, calls, db } = createTestBot({ now: sept28 });
    storeSept28Rates(db);
    await bot.handleUpdate(
      textUpdate({ updateId: 1, messageId: 10, text: '450 кофе', date: sept28 }),
    );
    await bot.handleUpdate(
      textUpdate({ updateId: 2, messageId: 11, text: '6 USD подписка', date: sept28 }),
    );
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 3, messageId: 12, text: '/today' }));

    // 45 000 + 61 907 minor.
    expect(sentTexts(calls)).toEqual([
      '<b>Сегодня, 28 сентября — «Личные расходы»</b>\n≈ 1 069.07 RSD\n\n' +
        'Включая 6.00 USD по курсу НБС на день траты.',
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
    quietFirstContact(db);
    let ids = 0;
    // The /start welcome and setup check take 99 and 100, so the first screen after them is 101.
    let messageId = 98;
    const bot = createBot({
      token: '123456:test-token',
      adminTelegramId: ALLOWED_ID,
      backupKeep: 14,
      logger: silentLogger(),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => NOW,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      keys: createLedgerKeyring(() => NOW),
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
    '<b>12.50 EUR</b>\nТранспорт: 12.50\n\n' +
    'Без курса НБС, не пересчитано: EUR.';
  const THIS_WEEK =
    '<b>Неделя, 28 сентября – 4 октября — «Личные расходы»</b>\n\n' +
    '<b>370.00 RSD</b>\nКафе и рестораны: 300.00\nБез категории: 70.00\n\n' +
    '<b>12.50 EUR</b>\nТранспорт: 12.50\n\n' +
    'Без курса НБС, не пересчитано: EUR.';

  // 3 420.00 RSD Другое, 450.00 RSD Кафе, 107.40 EUR Связь and 6.00 USD Другое, all on the 28th.
  async function convertedWeekBot(opts: { rates: boolean; kzt?: boolean }) {
    const bot = await summaryBot({ fixture: false });
    if (opts.rates) storeSept28Rates(bot.db);
    bot.add('W1', '2026-09-28', 342000, 'RSD', 'other');
    bot.add('W2', '2026-09-28', 45000, 'RSD', 'cafe');
    bot.add('W3', '2026-09-28', 10740, 'EUR', 'telecom');
    bot.add('W4', '2026-09-28', 600, 'USD', 'other');
    if (opts.kzt === true) bot.add('W5', '2026-09-28', 500000, 'KZT', 'other');
    return bot;
  }

  const WEEK_28_HEADER = '<b>Неделя, 28 сентября – 4 октября — «Личные расходы»</b>';
  const CONVERTED_WEEK_28 =
    '<b>≈ 17 108.49 RSD</b>\nСвязь и интернет: 12 619.42\nДругое: 4 039.07\n' +
    'Кафе и рестораны: 450.00';

  it('converts the week into one RSD total at the NBS rate of each day', async () => {
    const { say, calls } = await convertedWeekBot({ rates: true });

    await say('/week', 2);

    expect((calls[0]?.payload as { text: string }).text).toBe(
      `${WEEK_28_HEADER}\n\n${CONVERTED_WEEK_28}\n\n` +
        'Включая 107.40 EUR, 6.00 USD по курсу НБС на день траты.',
    );
  });

  it('keeps a currency NBS does not list in its own block, named in a note', async () => {
    const { say, calls } = await convertedWeekBot({ rates: true, kzt: true });

    await say('/week', 2);

    expect((calls[0]?.payload as { text: string }).text).toBe(
      `${WEEK_28_HEADER}\n\n${CONVERTED_WEEK_28}\n\n` +
        '<b>5 000.00 KZT</b>\nДругое: 5 000.00\n\n' +
        'Включая 107.40 EUR, 6.00 USD по курсу НБС на день траты.\n' +
        'Без курса НБС, не пересчитано: KZT.',
    );
  });

  it('shows each currency apart, with no ≈, while no rate is stored', async () => {
    const { say, calls } = await convertedWeekBot({ rates: false });

    await say('/week', 2);

    expect((calls[0]?.payload as { text: string }).text).toBe(
      `${WEEK_28_HEADER}\n\n` +
        '<b>3 870.00 RSD</b>\nДругое: 3 420.00\nКафе и рестораны: 450.00\n\n' +
        '<b>107.40 EUR</b>\nСвязь и интернет: 107.40\n\n' +
        '<b>6.00 USD</b>\nДругое: 6.00\n\n' +
        'Без курса НБС, не пересчитано: EUR, USD.',
    );
  });

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

  it('sorts a group week by converted total: Анна with 107.40 EUR before Борис with 3 420.00 RSD', async () => {
    const sept28 = new Date('2026-09-28T08:00:00Z');
    const { bot, calls, db } = createTestBot({ now: sept28 });
    storeSept28Rates(db);
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 1,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    const say = (updateId: number, fromId: number, firstName: string, text: string) =>
      bot.handleUpdate(
        groupTextUpdate({
          updateId,
          fromId,
          firstName,
          text,
          messageId: updateId + 10,
          date: sept28,
        }),
      );
    await say(2, ALLOWED_ID, 'Анна', '107,40 EUR интернет');
    await say(3, SECOND_ALLOWED_ID, 'Борис', '3420 разное');
    calls.length = 0;

    await say(4, ALLOWED_ID, 'Анна', '/week');

    const text = (calls[0]?.payload as { chat_id: number; text: string }).text;
    expect((calls[0]?.payload as { chat_id: number }).chat_id).toBe(GROUP_ID);
    expect(text).toContain('<b>≈ 16 039.42 RSD</b>');
    expect(text).toContain(
      '<b>По участникам</b>\nАнна: ≈ 12 619.42 RSD\nБорис: 3 420.00 RSD\n\n' +
        'Включая 107.40 EUR по курсу НБС на день траты.',
    );
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

    it('keeps the ≈ total and the conversion notes in the fallback', () => {
      const text = messages.periodSummary({
        ...view(30),
        convertedFrom: [{ currency: 'USD', amountMinor: 600 }],
        unconverted: ['KZT'],
      });

      expect(visible(text)).toBeLessThanOrEqual(4096);
      expect(text).not.toContain('Категория с длинным именем');
      // AMD comes first in the view: 30 * 123 456 789 minor.
      expect(text).toContain('<b>≈ 37 037 036.70 AMD</b>\n');
      expect(text).toContain(
        'Включая 6.00 USD по курсу НБС на день траты.\nБез курса НБС, не пересчитано: KZT.\n\n' +
          'Категорий слишком много для одного сообщения, поэтому показаны только итоги.',
      );
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
        quietFirstContact(memory);
        return memory;
      })();
    let messageId = opts.firstMessageId ?? 100;
    const bot = createBot({
      token: '123456:test-token',
      adminTelegramId: ALLOWED_ID,
      backupKeep: 14,
      logger: silentLogger(),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => clock.now,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      keys: createLedgerKeyring(() => clock.now),
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
      [{ text: 'Обязательные', callback_data: 'cat:ess' }],
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

  it('sets essential from the picker: cat:ess:<id>:1 twice leaves 1 and edits once', async () => {
    const { say, tap, calls, db } = flowBot();
    await say('/categories', 1);
    const cafe = db
      .prepare("SELECT id FROM categories WHERE name = 'Кафе и рестораны'")
      .pluck()
      .get() as number;
    await tap('cat:ess', 101);
    const picker = calls.at(-1)?.payload as {
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    // Each button carries the value it sets: the opposite of the one it shows.
    expect(picker.reply_markup.inline_keyboard[0]).toEqual([
      { text: '✓ Продукты', callback_data: `cat:ess:${String(cafe - 1)}:0` },
      { text: 'Кафе и рестораны', callback_data: `cat:ess:${String(cafe)}:1` },
    ]);
    calls.length = 0;

    await tap(`cat:ess:${String(cafe)}:1`, 101);
    await tap(`cat:ess:${String(cafe)}:1`, 101);

    expect(db.prepare('SELECT essential FROM categories WHERE id = ?').pluck().get(cafe)).toBe(1);
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1);
    expect(calls.at(-1)).toEqual({
      method: 'answerCallbackQuery',
      payload: { callback_query_id: 'cb-4', text: 'Уже отмечено' },
    });
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
      'Время ответа истекло. Начните заново.',
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
    quietFirstContact(db);
    const logLines: string[] = [];
    let ids = 0;
    let messageId = 100;
    const bot = createBot({
      token: '123456:test-token',
      adminTelegramId: ALLOWED_ID,
      backupKeep: 14,
      logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => clock.now,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      keys: createLedgerKeyring(() => clock.now),
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
      [{ text: 'Шифрование', callback_data: 'set:enc' }],
      // Tips are off for a test user that isn't about them.
      [{ text: 'Подсказки: выкл', callback_data: 'set:tips' }],
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
      [{ text: 'Обязательные', callback_data: 'cat:ess' }],
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
        '<b>Сегодня, 29 сентября — «Личные расходы»</b>\n450.00 EUR\n100.00 RSD\n\n' +
          'Без курса НБС, не пересчитано: RSD.',
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

      // The welcome and setup check took 101 and 102.
      await tap('set:cur:EUR', 103);

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

describe('fiscal receipts', () => {
  // 2026-10-01T08:00:00Z; the synthetic receipt was issued 2026-09-30T22:30:00Z.
  const RECEIPT_SENT = new Date('2026-10-01T08:00:00Z');
  const RS_LINK = buildRsUrl();
  const RS_CARD = 'Записано в «Личные расходы»: <b>829.12 RSD</b> — Чек · Другое';

  function receiptBot(
    options: { logLevel?: 'info' | 'silent'; failMethods?: readonly string[] } = {},
  ) {
    const harness = createTestBot({ now: RECEIPT_SENT, ...options });
    let updateId = 0;
    const send = (text: string, fromId = ALLOWED_ID) =>
      harness.bot.handleUpdate(
        textUpdate({ updateId: ++updateId, messageId: updateId, text, fromId, date: RECEIPT_SENT }),
      );
    const setTimezone = (timezone: string) =>
      harness.db.prepare('UPDATE users SET timezone = ?').run(timezone);
    // getFile answers with `files/<file_id>`; the harness's fake answers `true` to the rest.
    const getFiles: string[] = [];
    harness.bot.api.config.use((prev, method, payload, signal) => {
      if (method !== 'getFile') return prev(method, payload, signal);
      const { file_id } = payload as { file_id: string };
      getFiles.push(file_id);
      return Promise.resolve({
        ok: true,
        result: { file_id, file_unique_id: file_id, file_path: `files/${file_id}` } as never,
      });
    });
    const sendMedia = (content: Record<string, unknown>) =>
      harness.bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: Math.floor(RECEIPT_SENT.getTime() / 1000),
          chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
          from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
          ...content,
        },
      });
    const sendPhoto = (fileId: string) =>
      sendMedia({
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: 's', width: 90, height: 90 },
          { file_id: fileId, file_unique_id: 'l', width: 1280, height: 1280, file_size: 200_000 },
        ],
      });
    const sendDocument = (fileId: string, mimeType: string, fileSize: number) =>
      sendMedia({
        document: {
          file_id: fileId,
          file_unique_id: fileId,
          mime_type: mimeType,
          file_size: fileSize,
        },
      });
    return { ...harness, send, setTimezone, sendPhoto, sendDocument, getFiles };
  }

  function receiptKeyboard(expenseId: string) {
    return {
      inline_keyboard: [
        [
          { text: 'Категория', callback_data: `exp:cat:${expenseId}` },
          { text: 'Изменить', callback_data: `exp:edit:${expenseId}` },
        ],
        [{ text: 'Повторять', callback_data: `rec:new:${expenseId}` }],
        [{ text: messages.undoButton, callback_data: `exp:undo:${expenseId}` }],
      ],
    };
  }

  function expenseIds(db: Db): unknown[] {
    return db.prepare('SELECT id FROM expenses ORDER BY rowid').pluck().all();
  }

  it('records a pasted SUF link as 82912 RSD dated the Belgrade day, with a pending receipt', async () => {
    const { send, calls, db } = receiptBot();
    await send('/start');
    calls.length = 0;

    await send(RS_LINK);

    const [expenseId] = expenseIds(db);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: RS_CARD,
          reply_markup: receiptKeyboard(String(expenseId)),
          ...htmlParseMode,
        },
      },
    ]);
    expect(
      db.prepare('SELECT amount_minor, currency, description, occurred_on FROM expenses').all(),
    ).toEqual([
      { amount_minor: 82912, currency: 'RSD', description: 'Чек', occurred_on: '2026-10-01' },
    ]);
    expect(db.prepare('SELECT fetch_state, fiscal_id FROM receipts').all()).toEqual([
      { fetch_state: 'pending', fiscal_id: 'AAAA1111-AAAA1111-16898' },
    ]);
  });

  it('dates the receipt the 30th for a London user, and the card names the date', async () => {
    const { send, setTimezone, calls, db } = receiptBot();
    await send('/start');
    setTimezone('Europe/London');
    calls.length = 0;

    await send(RS_LINK);

    expect(db.prepare('SELECT occurred_on FROM expenses').pluck().all()).toEqual(['2026-09-30']);
    expect(sentTexts(calls)).toEqual([
      'Записано в «Личные расходы» за 30 сентября: <b>829.12 RSD</b> — Чек · Другое',
    ]);
  });

  it('answers the same link sent again with «уже записано» and the existing card', async () => {
    const { send, calls, db } = receiptBot();
    await send(RS_LINK);
    calls.length = 0;

    await send(RS_LINK);

    const [expenseId] = expenseIds(db);
    expect(expenseCount(db)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toEqual({ n: 1 });
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: `Уже записано.\n${RS_CARD}`,
          reply_markup: receiptKeyboard(String(expenseId)),
          ...htmlParseMode,
        },
      },
    ]);
  });

  it("records the same link from a second user in that user's personal ledger", async () => {
    const { send, db } = receiptBot();
    await send(RS_LINK);

    await send(RS_LINK, SECOND_ALLOWED_ID);

    expect(expenseCount(db)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(DISTINCT ledger_id) AS n FROM expenses').get()).toEqual({
      n: 2,
    });
  });

  it('refuses a receipt issued after the local date of the message and records nothing', async () => {
    const { send, calls, db } = receiptBot();

    await send(buildRsUrl({ issuedMs: Date.parse('2026-10-02T09:00:00Z') }));

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls)).toEqual([messages.futureReceipt]);
  });

  it.each([
    ['a refund', { transactionType: 1 }, messages.receiptRefused.refund],
    ['a copy', { invoiceType: 2 }, messages.receiptRefused.notSale],
    ['a fractional total', { rawTotal: 8291250n }, messages.receiptRefused.fractionalTotal],
  ] as const)('refuses %s and records nothing', async (_name, fields, reply) => {
    const { send, calls, db } = receiptBot();

    await send(buildRsUrl(fields));

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls)).toEqual([reply]);
  });

  it('sends a SUF link next to other words to the expense parser', async () => {
    const { send, db } = receiptBot();

    await send(`кофе ${RS_LINK}`);

    expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE source_key LIKE 'rcpt:%'").get(),
    ).toEqual({ n: 0 });
  });

  it('sends a SUF link with a Latin note after it to the expense parser', async () => {
    const { send, calls, db } = receiptBot();

    await send(`${RS_LINK} kafa`);

    expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toEqual({ n: 0 });
    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls)).not.toContain(messages.receiptRefused.malformed);
  });

  describe('Montenegro', () => {
    const IIC = 'abcdef0123456789abcdef0123456789';
    const meLink = (iic = IIC) =>
      `https://mapr.tax.gov.me/ic/#/verify?iic=${iic}&tin=02000000&crtd=2026-09-30T23:15:00+02:00&prc=42.50&bu=ab123cd456&cr=xy987zz123`;

    it.each([
      ['Europe/Podgorica', '2026-09-30'],
      ['Europe/Moscow', '2026-10-01'],
    ])('records 4250 EUR for a user in %s dated %s', async (timezone, occurredOn) => {
      const { send, setTimezone, db } = receiptBot();
      await send('/start');
      setTimezone(timezone);

      await send(meLink());

      expect(
        db.prepare('SELECT amount_minor, currency, description, occurred_on FROM expenses').all(),
      ).toEqual([
        { amount_minor: 4250, currency: 'EUR', description: 'Чек', occurred_on: occurredOn },
      ]);
      expect(db.prepare('SELECT country, fiscal_id FROM receipts').all()).toEqual([
        { country: 'ME', fiscal_id: IIC },
      ]);
    });

    it('treats an iic that differs only in case as the same receipt', async () => {
      const { send, calls, db } = receiptBot();
      await send(meLink());
      calls.length = 0;

      await send(meLink(IIC.toUpperCase()));

      expect(expenseCount(db)).toEqual({ n: 1 });
      expect(String(sentTexts(calls)[0])).toMatch(/^Уже записано\.\n/);
    });
  });

  describe('photos and image files', () => {
    // The download goes through fetch; it serves the QR fixtures by file id.
    const realFetch = globalThis.fetch;
    let fetched: string[] = [];
    beforeEach(() => {
      fetched = [];
      globalThis.fetch = (input) => {
        const url = String(input instanceof Request ? input.url : input);
        fetched.push(url);
        const name = url.slice(url.lastIndexOf('/') + 1);
        const body = readFileSync(new URL(`../fiscal/qr.fixtures/${name}`, import.meta.url));
        return Promise.resolve(new Response(body));
      };
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('records a photo of the Serbian receipt QR like the pasted link: 82912 RSD', async () => {
      const { sendPhoto, calls, db, getFiles } = receiptBot();

      await sendPhoto('rs-receipt.jpg');

      expect(getFiles).toEqual(['rs-receipt.jpg']);
      expect(fetched).toEqual([
        'https://api.telegram.org/file/bot123456:test-token/files/rs-receipt.jpg',
      ]);
      expect(db.prepare('SELECT amount_minor, currency, occurred_on FROM expenses').all()).toEqual([
        { amount_minor: 82912, currency: 'RSD', occurred_on: '2026-10-01' },
      ]);
      // The card, then one delete of the photo's message.
      expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'deleteMessage']);
      expect(sentTexts(calls)[0]).toBe(RS_CARD);
      expect(calls[1]).toEqual({
        method: 'deleteMessage',
        payload: { chat_id: ALLOWED_ID, message_id: 1 },
      });
    });

    it('answers a duplicate photo with alreadyRecorded and deletes it too', async () => {
      const { sendPhoto, calls, db } = receiptBot();
      await sendPhoto('rs-receipt.jpg');
      calls.length = 0;

      await sendPhoto('rs-receipt.jpg');

      expect(expenseCount(db)).toEqual({ n: 1 });
      // The card, then one delete of the photo's message.
      expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'deleteMessage']);
      expect(sentTexts(calls)[0]).toBe(`Уже записано.\n${RS_CARD}`);
      expect(calls[1]).toEqual({
        method: 'deleteMessage',
        payload: { chat_id: ALLOWED_ID, message_id: 2 },
      });
    });

    it('still sends the card and keeps the expense when the photo delete fails', async () => {
      const { sendPhoto, calls, db, logLines } = receiptBot({
        logLevel: 'info',
        failMethods: ['deleteMessage'],
      });

      await sendPhoto('rs-receipt.jpg');

      expect(expenseCount(db)).toEqual({ n: 1 });
      expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'deleteMessage']);
      expect(sentTexts(calls)[0]).toBe(RS_CARD);
      const warns = logLines.filter((line) => line.includes('receipt photo delete failed'));
      expect(warns).toHaveLength(1);
      expect(JSON.parse(String(warns[0]))).toMatchObject({ level: 40 });
    });

    it('records the same receipt sent as a photo and then as a link once', async () => {
      const { sendPhoto, send, calls, db } = receiptBot();
      await sendPhoto('rs-receipt.jpg');
      calls.length = 0;

      await send(RS_LINK);

      expect(expenseCount(db)).toEqual({ n: 1 });
      expect(sentTexts(calls)).toEqual([`Уже записано.\n${RS_CARD}`]);
    });

    it('records a photo of a wrapped :443 receipt QR, then answers its plain link as recorded', async () => {
      const { sendPhoto, send, calls, db } = receiptBot();

      await sendPhoto('rs-receipt-wrapped.jpg');

      expect(db.prepare('SELECT amount_minor, currency FROM expenses').all()).toEqual([
        { amount_minor: 82912, currency: 'RSD' },
      ]);
      expect(sentTexts(calls.filter((c) => c.method === 'sendMessage'))).toEqual([RS_CARD]);
      calls.length = 0;

      await send(RS_LINK);

      expect(expenseCount(db)).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toEqual({ n: 1 });
      expect(sentTexts(calls)).toEqual([`Уже записано.\n${RS_CARD}`]);
    });

    it('reads an image sent as a file', async () => {
      const { sendDocument, db } = receiptBot();

      await sendDocument('rs-receipt.jpg', 'image/jpeg', 200_000);

      expect(db.prepare('SELECT amount_minor FROM expenses').pluck().all()).toEqual([82912]);
    });

    it.each([
      ['no QR', 'no-qr.jpg'],
      ['a QR that is not a receipt', 'example.png'],
    ])('answers a photo with %s with the no-QR hint and records nothing', async (_name, fileId) => {
      const { sendPhoto, calls, db } = receiptBot();

      await sendPhoto(fileId);

      expect(expenseCount(db)).toEqual({ n: 0 });
      expect(sentTexts(calls)).toEqual([messages.receiptPhotoNoQr]);
    });

    it('logs why a located receipt QR did not decode, with the unreadable hint and nothing recorded', async () => {
      const { sendPhoto, calls, db, logLines } = receiptBot({ logLevel: 'info' });

      await sendPhoto('rs-receipt-damaged.jpg');

      expect(expenseCount(db)).toEqual({ n: 0 });
      // The unread photo stays: no deleteMessage.
      expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
      expect(sentTexts(calls)).toEqual([messages.receiptPhotoUnreadable]);
      const reads = logLines.filter((line) => line.includes('receipt image read'));
      expect(reads).toHaveLength(1);
      expect(JSON.parse(String(reads[0]))).toMatchObject({
        level: 30,
        source: 'photo',
        bytes: 200_000,
        width: 1280,
        height: 1280,
        outcome: 'noQr',
        detected: { error: 'ChecksumError', version: '23', ecLevel: 'M', modulePx: 4 },
      });
    });

    it('logs a read receipt photo without its QR text', async () => {
      const { sendPhoto, logLines } = receiptBot({ logLevel: 'info' });

      await sendPhoto('rs-receipt.jpg');

      const reads = logLines.filter((line) => line.includes('receipt image read'));
      expect(reads).toHaveLength(1);
      expect(JSON.parse(String(reads[0]))).toMatchObject({
        outcome: 'receipt',
        qrCount: 1,
        pass: 'plain',
      });
      for (const line of logLines) expect(line).not.toContain('suf.purs.gov.rs');
    });

    it('records a dot-gain receipt photo through a pixel retry and logs its pass', async () => {
      const { sendPhoto, calls, db, logLines } = receiptBot({ logLevel: 'info' });

      await sendPhoto('rs-receipt-dotgain.jpg');

      expect(db.prepare('SELECT amount_minor, currency FROM expenses').all()).toEqual([
        { amount_minor: 82912, currency: 'RSD' },
      ]);
      expect(sentTexts(calls.filter((c) => c.method === 'sendMessage'))).toEqual([RS_CARD]);
      const reads = logLines.filter((line) => line.includes('receipt image read'));
      expect(reads).toHaveLength(1);
      expect(JSON.parse(String(reads[0]))).toMatchObject({
        outcome: 'receipt',
        qrCount: 1,
        pass: VARIANTS[0]?.name,
      });
      expect(VARIANTS[0]?.name).toBe('blur3-lmt21-3');
      for (const line of logLines) expect(line).not.toContain('suf.purs.gov.rs');
    });

    it('logs a pixel decode refused over the limit, with the no-QR hint', async () => {
      const { sendPhoto, calls, logLines } = receiptBot({ logLevel: 'info' });
      // rs-receipt.jpg with its baseline frame header (FF C0 at byte 89) claiming 20000x20000.
      const bytes = readFileSync(new URL('../fiscal/qr.fixtures/rs-receipt.jpg', import.meta.url));
      expect([bytes[89], bytes[90]]).toEqual([0xff, 0xc0]);
      bytes.writeUInt16BE(20000, 89 + 5);
      bytes.writeUInt16BE(20000, 89 + 7);
      globalThis.fetch = () => Promise.resolve(new Response(bytes));

      await sendPhoto('huge.jpg');

      expect(sentTexts(calls)).toEqual([messages.receiptPhotoNoQr]);
      const reads = logLines.filter((line) => line.includes('receipt image read'));
      expect(reads).toHaveLength(1);
      expect(JSON.parse(String(reads[0]))).toMatchObject({
        outcome: 'noQr',
        pixelDecode: 'overLimit',
      });
    });

    it('does not download an image file over 20 MB and answers with the no-QR hint', async () => {
      const { sendDocument, calls, getFiles } = receiptBot();

      await sendDocument('rs-receipt.jpg', 'image/jpeg', 25_000_000);

      expect(getFiles).toEqual([]);
      expect(fetched).toEqual([]);
      expect(sentTexts(calls)).toEqual([messages.receiptPhotoNoQr]);
    });

    it('suggests an uncompressed file in no message', () => {
      // The source, so copy built by message functions is covered too.
      const source = readFileSync(new URL('./messages.ts', import.meta.url), 'utf8');
      expect(source).toContain('receiptPhotoUnreadable');
      expect(source).not.toContain('без сжатия');
    });

    it('does not download a non-image file and keeps the help reply', async () => {
      const { sendDocument, calls, getFiles } = receiptBot();

      await sendDocument('report.docx', 'application/msword', 1000);

      expect(getFiles).toEqual([]);
      expect(fetched).toEqual([]);
      expect(sentTexts(calls)).toEqual([messages.help]);
    });

    it('never logs the download URL, which carries the bot token', async () => {
      const { sendPhoto, logLines } = receiptBot({ logLevel: 'info' });
      globalThis.fetch = (input) => {
        fetched.push(String(input instanceof Request ? input.url : input));
        return Promise.resolve(new Response('gone', { status: 404 }));
      };

      await sendPhoto('rs-receipt.jpg');

      expect(fetched).toHaveLength(1);
      expect(logLines.some((line) => line.includes('handler failed'))).toBe(true);
      for (const line of logLines) {
        expect(line).not.toContain('test-token');
        expect(line).not.toContain('api.telegram.org/file');
      }
    });
  });

  describe('[Позиции] and [Повторить]', () => {
    function settle(db: Db, state: 'fetched' | 'failed', names: readonly string[] = []) {
      const receiptId = db.prepare('SELECT id FROM receipts').pluck().get();
      db.prepare(
        'UPDATE receipts SET fetch_state = ?, seller_name = ?, attempts = 6, next_fetch_at = NULL',
      ).run(state, state === 'fetched' ? 'Test Market' : null);
      const insert = db.prepare(
        "INSERT INTO receipt_items (receipt_id, position, name, quantity, total_minor) VALUES (?, ?, ?, '1', 100)",
      );
      names.forEach((name, index) => insert.run(receiptId, index + 1, name));
    }

    // A fetched receipt with these items, each `[name, quantity, total_minor]`.
    function settleItems(
      db: Db,
      sellerName: string,
      items: readonly (readonly [string, string, number])[],
    ) {
      const receiptId = db.prepare('SELECT id FROM receipts').pluck().get();
      db.prepare(
        "UPDATE receipts SET fetch_state = 'fetched', seller_name = ?, attempts = 1, next_fetch_at = NULL",
      ).run(sellerName);
      const insert = db.prepare(
        'INSERT INTO receipt_items (receipt_id, position, name, quantity, total_minor) VALUES (?, ?, ?, ?, ?)',
      );
      items.forEach(([name, quantity, totalMinor], index) =>
        insert.run(receiptId, index + 1, name, quantity, totalMinor),
      );
    }

    async function tapAs(bot: Bot, data: string, fromId = ALLOWED_ID, updateId = 900) {
      await bot.handleUpdate(callbackUpdate({ updateId, data, fromId }));
    }

    function cardKeyboard(expenseId: string, withItems: boolean) {
      return {
        inline_keyboard: [
          [
            { text: 'Категория', callback_data: `exp:cat:${expenseId}` },
            { text: 'Изменить', callback_data: `exp:edit:${expenseId}` },
          ],
          [{ text: 'Повторять', callback_data: `rec:new:${expenseId}` }],
          ...(withItems ? [[{ text: 'Позиции', callback_data: `exp:items:${expenseId}:1` }]] : []),
          [{ text: 'Удалить', callback_data: `exp:undo:${expenseId}` }],
        ],
      };
    }

    it('folds a fetched receipt card’s items into an expandable quote, with no [Позиции]', async () => {
      const { send, bot, calls, db } = receiptBot();
      await send(RS_LINK);
      settleItems(db, 'Test Market', [
        ['Хлеб', '0.535', 7999],
        ['Молоко', '1', 14900],
      ]);
      const [expenseId] = expenseIds(db);
      calls.length = 0;

      await tapAs(bot, showExpenseData(String(expenseId) as ExpenseId));

      const edit = calls.find((c) => c.method === 'editMessageText');
      expect(edit?.payload).toMatchObject({
        text: `${RS_CARD}\nTest Market · 2 позиции\n<blockquote expandable>1. Хлеб × 0.535 — 79.99 RSD\n2. Молоко — 149.00 RSD</blockquote>`,
        reply_markup: cardKeyboard(String(expenseId), false),
      });
    });

    it('keeps [Позиции] and no quote when the items would push the card past 4096 characters', async () => {
      const { send, bot, calls, db } = receiptBot();
      await send(RS_LINK);
      const items = Array.from(
        { length: 80 },
        (_, i) => [`${String(i + 1).padStart(3, '0')} ${'я'.repeat(56)}`, '1', 12345] as const,
      );
      settleItems(db, 'Test Market', items);
      const [expenseId] = expenseIds(db);
      calls.length = 0;

      await tapAs(bot, showExpenseData(String(expenseId) as ExpenseId));

      const edit = calls.find((c) => c.method === 'editMessageText');
      expect(edit?.payload).toMatchObject({
        text: `${RS_CARD}\nTest Market · 80 позиций`,
        reply_markup: cardKeyboard(String(expenseId), true),
      });
    });

    it('escapes a shop and item name holding markup inside the folded card', async () => {
      const { send, bot, calls, db } = receiptBot();
      await send(RS_LINK);
      settleItems(db, '<b>Shop</b>', [['<b>Хлеб</b>', '1', 7999]]);
      const [expenseId] = expenseIds(db);
      calls.length = 0;

      await tapAs(bot, showExpenseData(String(expenseId) as ExpenseId));

      const { text } = calls.find((c) => c.method === 'editMessageText')?.payload as {
        text: string;
      };
      expect(text).toContain('&lt;b&gt;Shop&lt;/b&gt; · 1 позиция');
      expect(text).toContain(
        '<blockquote expandable>1. &lt;b&gt;Хлеб&lt;/b&gt; — 79.99 RSD</blockquote>',
      );
    });

    it('edits the remembered card into the folded-items card once the worker fetches it', async () => {
      const { send, bot, calls, db, keys } = receiptBot();
      withMessageIds(bot, 300);
      await send(RS_LINK);
      calls.length = 0;
      const fetcher = () =>
        Promise.resolve({
          kind: 'fetched',
          receipt: {
            sellerName: 'Test Market',
            totalMinor: 22899,
            items: [
              { name: 'Хлеб', quantity: '0.535', totalMinor: 7999 },
              { name: 'Молоко', quantity: '1', totalMinor: 14900 },
            ],
          },
        } as const);

      const worker = startReceiptWorker(
        {
          db,
          logger: silentLogger(),
          newId: () => 'unused',
          now: () => RECEIPT_SENT,
          defaultTimezone: 'Europe/Belgrade',
          defaultCurrency: 'RSD',
          keys,
          fetchers: { RS: fetcher, ME: fetcher },
        },
        bot.api,
      );
      await worker.stop();

      const [expenseId] = expenseIds(db);
      expect(calls.filter((c) => c.method === 'editMessageText')).toEqual([
        {
          method: 'editMessageText',
          payload: {
            chat_id: ALLOWED_ID,
            message_id: 301,
            text: 'Записано в «Личные расходы»: <b>829.12 RSD</b> — Test Market · Другое\nTest Market · 2 позиции\n<blockquote expandable>1. Хлеб × 0.535 — 79.99 RSD\n2. Молоко — 149.00 RSD</blockquote>',
            reply_markup: cardKeyboard(String(expenseId), false),
            ...htmlParseMode,
          },
        },
      ]);
    });

    it('pages 120 items of 60 characters within 4096 characters a page, all in order', () => {
      const items = Array.from({ length: 120 }, (_, i) => ({
        name: `${String(i + 1).padStart(3, '0')} ${'я'.repeat(56)}`,
        quantity: '1',
        totalMinor: 12345,
      }));

      const pages = messages.receiptItemPages({
        sellerName: 'Test Market',
        currency: 'RSD',
        items,
      });

      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(4096);
      const listed = pages.flatMap((page) =>
        page
          .split('\n')
          .slice(1)
          .map((line) => line.slice(line.indexOf(' ') + 1, line.indexOf(' ') + 4)),
      );
      expect(listed).toEqual(items.map((item) => item.name.slice(0, 3)));
    });

    it('escapes item names and shows a quantity other than 1', () => {
      const [page] = messages.receiptItemPages({
        sellerName: 'Test Market',
        currency: 'RSD',
        items: [
          { name: '<b>Хлеб & Co</b>', quantity: '1', totalMinor: 7999 },
          { name: 'Сыр', quantity: '0.535', totalMinor: 2913 },
        ],
      });

      expect(page).toBe(
        '<b>Test Market</b> · 2 позиции\n1. &lt;b&gt;Хлеб &amp; Co&lt;/b&gt; — 79.99 RSD\n2. Сыр × 0.535 — 29.13 RSD',
      );
    });

    it('edits the card into the item list with [« Назад]', async () => {
      const { send, bot, calls, db } = receiptBot();
      await send(RS_LINK);
      settle(db, 'fetched', ['<b>Хлеб & Co</b>']);
      const [expenseId] = expenseIds(db);
      calls.length = 0;

      await tapAs(bot, receiptItemsData(String(expenseId) as ExpenseId, 1));

      expect(calls.find((c) => c.method === 'editMessageText')?.payload).toMatchObject({
        text: '<b>Test Market</b> · 1 позиция\n1. &lt;b&gt;Хлеб &amp; Co&lt;/b&gt; — 1.00 RSD',
        reply_markup: {
          inline_keyboard: [[{ text: '« Назад', callback_data: `exp:show:${String(expenseId)}` }]],
        },
      });
    });

    it("answers [Позиции] on another user's expense like other card taps, revealing no items", async () => {
      const { send, bot, calls, db } = receiptBot();
      await send(RS_LINK);
      await send('/start', SECOND_ALLOWED_ID);
      settle(db, 'fetched', ['Hleb']);
      const [expenseId] = expenseIds(db);
      calls.length = 0;

      await tapAs(bot, receiptItemsData(String(expenseId) as ExpenseId, 1), SECOND_ALLOWED_ID);

      expect(calls).toEqual([
        {
          method: 'answerCallbackQuery',
          payload: { callback_query_id: 'cb-900', text: messages.receiptItemsForbidden },
        },
      ]);
    });

    it('resets a failed receipt once on a double tap of [Повторить], and the worker fetches it once', async () => {
      const { send, bot, calls, db } = receiptBot();
      await send(RS_LINK);
      settle(db, 'failed');
      const [expenseId] = expenseIds(db);
      calls.length = 0;

      await tapAs(bot, receiptRetryData(String(expenseId) as ExpenseId), ALLOWED_ID, 901);
      await tapAs(bot, receiptRetryData(String(expenseId) as ExpenseId), ALLOWED_ID, 902);

      expect(db.prepare('SELECT fetch_state, attempts FROM receipts').all()).toEqual([
        { fetch_state: 'pending', attempts: 0 },
      ]);
      expect(
        calls
          .filter((c) => c.method === 'answerCallbackQuery')
          .map((c) => (c.payload as { text?: string }).text),
      ).toEqual([messages.receiptRetryToast, messages.receiptRetryNotFailed]);

      let fetches = 0;
      const fetcher = () => {
        fetches++;
        return Promise.resolve({
          kind: 'fetched',
          receipt: { sellerName: 'Test Market', totalMinor: 82912, items: [] },
        } as const);
      };
      const deps = {
        db,
        logger: silentLogger(),
        newId: () => 'unused',
        defaultTimezone: 'Europe/Belgrade',
        fetchers: { RS: fetcher, ME: fetcher },
        placeholder: messages.receiptPlaceholder,
      };
      const signal = new AbortController().signal;
      expect((await fetchDueReceipt(deps, { now: RECEIPT_SENT, signal })).kind).toBe('settled');
      expect(await fetchDueReceipt(deps, { now: RECEIPT_SENT, signal })).toEqual({
        kind: 'idle',
      });
      expect(fetches).toBe(1);
    });
  });

  it('logs the receipt and expense ids and the country, never the amount, URL or fiscal id', async () => {
    const { send, logLines, db } = receiptBot({ logLevel: 'info' });

    await send(RS_LINK);
    await send(RS_LINK);

    const receiptLines = logLines.filter((line) => line.includes('receipt'));
    expect(receiptLines).toHaveLength(2);
    const receiptId = db.prepare('SELECT id FROM receipts').pluck().get();
    expect(JSON.parse(receiptLines[0] ?? '{}')).toMatchObject({
      receiptId,
      expenseId: expenseIds(db)[0],
      country: 'RS',
    });
    for (const line of logLines) {
      const content = logContent(line);
      expect(content).not.toContain('AAAA1111');
      expect(content).not.toContain('82912');
      expect(content).not.toContain('829.12');
      expect(content).not.toContain('suf.purs');
      expect(content).not.toContain(RS_LINK.slice(40, 80));
    }
  });
});

describe('bank card-purchase SMS (ADR-0021)', () => {
  // The synthetic SMS's purchase is 2026-09-14T22:30:00Z, 00:30 on the 15th in Belgrade.
  const SMS_SENT = new Date('2026-09-15T08:00:00Z');
  const SMS = buildKoriscenjeSms();
  const SMS_CARD = 'Записано в «Личные расходы»: <b>6.00 USD</b> — EXAMPLE.COM · Другое';

  function smsBot() {
    const harness = createTestBot({ now: SMS_SENT });
    let updateId = 0;
    const send = (text: string) =>
      harness.bot.handleUpdate(
        textUpdate({ updateId: ++updateId, messageId: updateId, text, date: SMS_SENT }),
      );
    const tap = (data: string) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data }));
    const setTimezone = (timezone: string) =>
      harness.db.prepare('UPDATE users SET timezone = ?').run(timezone);
    return { ...harness, send, tap, setTimezone };
  }

  function cardKeyboard(expenseId: unknown) {
    const id = String(expenseId);
    return {
      inline_keyboard: [
        [
          { text: 'Категория', callback_data: `exp:cat:${id}` },
          { text: 'Изменить', callback_data: `exp:edit:${id}` },
        ],
        [{ text: 'Повторять', callback_data: `rec:new:${id}` }],
        [{ text: messages.undoButton, callback_data: `exp:undo:${id}` }],
      ],
    };
  }

  function expenses(db: Db): unknown[] {
    return db
      .prepare('SELECT amount_minor, currency, description, occurred_on FROM expenses')
      .all();
  }

  it('records a pasted SMS as 600 USD dated the Belgrade day, then answers a re-paste as recorded', async () => {
    const { send, calls, db } = smsBot();
    await send('/start');
    calls.length = 0;

    await send(SMS);
    await send(SMS);

    const expenseId = db.prepare('SELECT id FROM expenses').pluck().get();
    expect(expenses(db)).toEqual([
      { amount_minor: 600, currency: 'USD', description: 'EXAMPLE.COM', occurred_on: '2026-09-15' },
    ]);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: SMS_CARD,
          reply_markup: cardKeyboard(expenseId),
          ...htmlParseMode,
        },
      },
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: `Уже записано.\n${SMS_CARD}`,
          reply_markup: cardKeyboard(expenseId),
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('dates the purchase the 14th for a New York user, 18:30 EDT', async () => {
    const { send, setTimezone, db } = smsBot();
    await send('/start');
    setTimezone('America/New_York');

    await send(SMS);

    expect(db.prepare('SELECT occurred_on FROM expenses').pluck().all()).toEqual(['2026-09-14']);
  });

  it.each([
    ['a zero amount', { iznos: '0,00 RSD' }, messages.bankSmsRefused.malformed],
    ['a dot decimal', { iznos: '6.00 USD' }, messages.bankSmsRefused.malformed],
    ['a missing Mesto line', { mesto: null }, messages.bankSmsRefused.malformed],
    ['31 February', { datum: '31.02.2026 10:00:00' }, messages.bankSmsRefused.malformed],
    [
      'an unknown currency',
      { iznos: '6,00 XYZ' },
      'В СМС валюта XYZ, её я пока не знаю. Ничего не записано.',
    ],
  ] as const)('refuses %s with its own reply and records nothing', async (_name, fields, reply) => {
    const { send, calls, db } = smsBot();

    await send(buildKoriscenjeSms(fields));

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls)).toEqual([reply]);
    expect(sentTexts(calls)).not.toContain(messages.help);
    expect(sentTexts(calls)).not.toContain(messages.invalidAmount);
  });

  it('refuses an SMS dated the day after the message and records nothing', async () => {
    const { send, calls, db } = smsBot();

    // 08:00 UTC on the 16th, pasted at 08:00 UTC on the 15th.
    await send(buildKoriscenjeSms({ datum: '16.09.2026 10:00:00' }));

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls)).toEqual([messages.bankSmsFuture]);
  });

  it('records an SMS from 00:30 pasted at 00:40 the same Belgrade night', async () => {
    const { bot, db } = smsBot();

    await bot.handleUpdate(
      textUpdate({ updateId: 1, text: SMS, date: new Date('2026-09-14T22:40:00Z') }),
    );

    expect(db.prepare('SELECT occurred_on FROM expenses').pluck().all()).toEqual(['2026-09-15']);
  });

  it('lists bank SMS in /help', async () => {
    const { send, calls } = smsBot();

    await send('/help');

    expect(String(sentTexts(calls)[0])).toContain(
      'СМС банка о покупке картой: перешлите или вставьте его текст, и я запишу сумму, дату и магазин. Пока понимаю сербские СМС «Korišćenje kartice».',
    );
  });

  it('says in /help that totals and budgets convert at the NBS rate', async () => {
    const { send, calls } = smsBot();

    await send('/help');

    expect(String(sentTexts(calls)[0])).toContain(
      'СМС банка о покупке картой: перешлите или вставьте его текст, и я запишу сумму, дату и магазин. Пока понимаю сербские СМС «Korišćenje kartice».\n' +
        'Итоги и бюджет в разных валютах пересчитываются в одну валюту по курсу НБС на день траты.',
    );
  });

  it('files a second SMS from the same merchant in the category the first was moved to', async () => {
    const { send, tap, db } = smsBot();
    await send(SMS);
    const firstId = db.prepare('SELECT id FROM expenses').pluck().get() as ExpenseId;
    const groceries = db
      .prepare("SELECT id FROM categories WHERE preset_key = 'groceries'")
      .pluck()
      .get() as CategoryId;
    await tap(setCategoryData(firstId, groceries));

    await send(buildKoriscenjeSms({ datum: '15.09.2026 09:00:00', iznos: '9,00 USD' }));

    expect(
      db
        .prepare(
          `SELECT e.amount_minor, c.name FROM expenses e JOIN categories c ON c.id = e.category_id
            ORDER BY e.rowid`,
        )
        .all(),
    ).toEqual([
      { amount_minor: 600, name: 'Продукты' },
      { amount_minor: 900, name: 'Продукты' },
    ]);
  });
});

describe('sealed ledger lifecycle and log hygiene (ADR-0020)', () => {
  const PASSPHRASE = 'synthetic passphrase 42';
  const NEW_PASSPHRASE = 'another synthetic one 7';

  // A trace-level logger and real message ids from sendMessage, so screens get an anchor.
  function traceBot() {
    const now = new Date('2026-09-30T10:00:00Z');
    const db = openDatabase(':memory:');
    runMigrations(db, now);
    quietFirstContact(db);
    const logLines: string[] = [];
    let ids = 0;
    let messageId = 100;
    const bot = createBot({
      token: '123456:test-token',
      adminTelegramId: ALLOWED_ID,
      backupKeep: 14,
      logger: createLogger('trace', { write: (line: string) => void logLines.push(line) }),
      db,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      now: () => now,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      keys: createLedgerKeyring(() => now),
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
      bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId: id, text, date: now }));
    const tap = (data: string, id: number) =>
      bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId: id }));
    const sent = () =>
      calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => (call.payload as { text: string }).text);
    return { calls, logLines, say, tap, sent };
  }

  it('/lock locks now, and /today then answers locked', async () => {
    const { calls, say, tap, sent } = traceBot();
    await say('/settings', 1);
    await tap(SETTINGS_ENCRYPTION, 101);
    await say(PASSPHRASE, 2);
    await say('/unlock', 3);
    await say(PASSPHRASE, 4);

    calls.length = 0;
    await say('/lock', 5);
    await say('/today', 6);
    await say('/lock', 7);
    expect(sent()).toEqual([
      messages.ledgerLockedNow,
      messages.ledgerLocked,
      messages.alreadyLocked,
    ]);
  });

  it('no log line at trace level carries the passphrase or the recovery code', async () => {
    const { logLines, say, tap, sent } = traceBot();
    await say('/settings', 1);
    await tap(SETTINGS_ENCRYPTION, 101);
    await say(PASSPHRASE, 2);
    const code = /<code>([A-Z2-7-]+)<\/code>/.exec(sent().join('\n'))?.[1];
    if (code === undefined) throw new Error('no recovery code shown');
    await tap(RECOVERY_SAVED, 102);
    await say('450 кофе', 3);
    await say('/unlock', 4);
    await say(PASSPHRASE, 5);
    await say('/today', 6);
    await say('/lock', 7);
    await say('/recover', 8);
    await say(code.toLowerCase(), 9);
    await say(NEW_PASSPHRASE, 10);

    expect(sent()).toContain(messages.passphraseChanged);
    // The run logged at all, so an empty log can't pass for a clean one.
    expect(logLines.some((line) => line.includes('ledger recovered'))).toBe(true);
    const secrets = [
      PASSPHRASE,
      NEW_PASSPHRASE,
      code,
      code.replaceAll('-', ''),
      code.toLowerCase(),
    ];
    for (const line of logLines) {
      for (const secret of secrets) expect(line, secret).not.toContain(secret);
    }
  });
});

describe('recurring expenses', () => {
  // `45000 аренда` sent on 1 October; the clock reads 2 October 12:00 CEST until moved.
  async function rentBot() {
    const clock = new Date('2026-10-02T10:00:00Z');
    const harness = createTestBot({ now: clock });
    let updateId = 0;
    const tap = (data: string) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data }));
    const send = (text: string) =>
      harness.bot.handleUpdate(
        textUpdate({ updateId: ++updateId, text, date: new Date('2026-10-01T10:00:00Z') }),
      );
    await send('45000 аренда');
    const deps = {
      db: harness.db,
      logger: silentLogger(),
      newId: randomUUID,
      now: () => clock,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD' as CurrencyCode,
      keys: harness.keys,
    };
    const providers = [register(recurringProvider(deps, harness.bot.api))];
    const tick = (at: string) => runTick({ logger: deps.logger, providers }, new Date(at));
    // Sent messages get ids, so a screen can become the anchor.
    let messageId = 100;
    harness.bot.api.config.use(async (prev, method, payload, signal) => {
      const answer = await prev(method, payload, signal);
      if (method !== 'sendMessage') return answer;
      const chat = { id: (payload as { chat_id: number }).chat_id, type: 'private' };
      return { ok: true, result: { message_id: ++messageId, date: 0, chat, text: '' } as never };
    });
    const tapOn = (data: string, message: number) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId: message }));
    const ruleId = () =>
      harness.db.prepare('SELECT id FROM recurring_rules').pluck().get() as string;
    const askMode = () => harness.db.prepare("UPDATE recurring_rules SET mode = 'ask'").run();
    const recorded = () =>
      harness.db
        .prepare(
          "SELECT amount_minor, occurred_on, deleted_at FROM expenses WHERE source_key LIKE 'rec:%'",
        )
        .all();
    const lastMessageId = () => messageId;
    return { ...harness, clock, tap, tapOn, send, tick, ruleId, askMode, recorded, lastMessageId };
  }

  function sent(calls: readonly ApiCall[]) {
    return calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload as { text: string; reply_markup?: { inline_keyboard: unknown[][] } });
  }

  it('/recurring opens a rule, switches it to ask mode, and the due tick asks instead of recording', async () => {
    const { tap, tapOn, send, tick, ruleId, recorded, calls, db, lastMessageId } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    await send('/recurring');
    const list = lastMessageId();

    await tapOn(`rec:r:${ruleId()}`, list);
    await tapOn('rec:mode:k', list);
    expect(db.prepare('SELECT mode FROM recurring_rules').pluck().get()).toBe('ask');
    calls.length = 0;

    await tick('2026-11-01T08:00:00Z');

    expect(recorded()).toEqual([]);
    const id = ruleId();
    expect(sent(calls)).toEqual([
      expect.objectContaining({
        text: 'По расписанию на 1 ноября: аренда, 45 000.00 RSD. Записать?',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Записать 45 000.00 RSD', callback_data: `rec:ok:${id}:2026-11-01` }],
            [
              { text: 'Другая сумма', callback_data: `rec:amt:${id}:2026-11-01` },
              { text: 'Пропустить', callback_data: `rec:skip:${id}:2026-11-01` },
            ],
          ],
        },
      }),
    ]);
  });

  it('[Записать] records the template on the due date, and a second tap records nothing', async () => {
    const { tap, tick, ruleId, askMode, recorded } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    askMode();
    await tick('2026-11-01T08:00:00Z');

    await tap(`rec:ok:${ruleId()}:2026-11-01`);
    await tap(`rec:ok:${ruleId()}:2026-11-01`);

    expect(recorded()).toEqual([
      { amount_minor: 4500000, occurred_on: '2026-11-01', deleted_at: null },
    ]);
  });

  it('[Другая сумма] then 4870 records 487000 minor units in RSD', async () => {
    const { tap, send, tick, ruleId, askMode, db } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    askMode();
    await tick('2026-11-01T08:00:00Z');

    await tap(`rec:amt:${ruleId()}:2026-11-01`);
    await send('4870');

    expect(
      db
        .prepare(
          "SELECT amount_minor, currency, occurred_on FROM expenses WHERE source_key LIKE 'rec:%'",
        )
        .all(),
    ).toEqual([{ amount_minor: 487000, currency: 'RSD', occurred_on: '2026-11-01' }]);
  });

  it('[Пропустить] records nothing and the prompt says «Пропущено»', async () => {
    const { tap, tick, ruleId, askMode, recorded, calls } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    askMode();
    await tick('2026-11-01T08:00:00Z');
    calls.length = 0;

    await tap(`rec:skip:${ruleId()}:2026-11-01`);
    await tap(`rec:ok:${ruleId()}:2026-11-01`);

    expect(recorded()).toEqual([]);
    expect(calls.find((c) => c.method === 'editMessageText')?.payload).toMatchObject({
      text: 'Пропущено: аренда.',
    });
  });

  it('after downtime an ask rule asks about the last 3 dates and names how many more it skipped', async () => {
    const { tap, tick, askMode, calls } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    askMode();
    calls.length = 0;

    await tick('2027-03-02T10:00:00Z');

    expect(sent(calls).map((m) => m.text)).toEqual([
      'Пока я не работал, по расписанию прошло ещё 2, их я пропустил.',
      'По расписанию на 1 января: аренда, 45 000.00 RSD. Записать?',
      'По расписанию на 1 февраля: аренда, 45 000.00 RSD. Записать?',
      'По расписанию на 1 марта: аренда, 45 000.00 RSD. Записать?',
    ]);
  });

  // A monthly reminder made on 2 October from /recurring.
  async function reminderBot() {
    const harness = await rentBot();
    await harness.send('/recurring');
    const list = harness.lastMessageId();
    await harness.tapOn('rec:rem', list);
    await harness.send('заплатить за интернет <до 5-го>');
    await harness.tapOn('rec:rs:m', list);
    await harness.tapOn('rec:rs:m', list);
    return harness;
  }

  it('a monthly reminder made on 2 October fires on 2 November at 09:00 local, escaped, recording nothing', async () => {
    const { tick, calls, db } = await reminderBot();
    expect(
      db.prepare("SELECT COUNT(*) FROM recurring_rules WHERE kind = 'reminder'").pluck().get(),
    ).toBe(1);
    calls.length = 0;

    await tick('2026-11-02T07:59:00Z');
    expect(sent(calls)).toEqual([]);
    await tick('2026-11-02T08:00:00Z');

    expect(sent(calls)).toEqual([
      expect.objectContaining({
        chat_id: ALLOWED_ID,
        text: '🔔 заплатить за интернет &lt;до 5-го&gt;',
        reply_markup: { inline_keyboard: [[{ text: 'Записать трату', callback_data: 'rec:rx' }]] },
      }),
    ]);
    expect(
      db.prepare("SELECT COUNT(*) FROM expenses WHERE source_key LIKE 'rec:%'").pluck().get(),
    ).toBe(0);
  });

  it('after three missed months sends one reminder, and the next date is in the future', async () => {
    const { tick, calls, db } = await reminderBot();
    calls.length = 0;

    await tick('2027-01-03T10:00:00Z');

    expect(sent(calls)).toHaveLength(1);
    expect(
      db.prepare("SELECT next_due_on FROM recurring_rules WHERE kind = 'reminder'").pluck().get(),
    ).toBe('2027-02-02');
  });

  it('keeps every recurring callback within 64 bytes', () => {
    const id = '00000000-0000-4000-8000-000000000003' as ExpenseId;
    const rule = id as unknown as RuleId;
    const day = '2026-11-01' as LocalDate;
    const data = [
      repeatExpenseData(id),
      repeatScheduleData(id, 'm'),
      ruleOpenData(rule),
      askData('ok', rule, day),
      askData('amt', rule, day),
      askData('skip', rule, day),
    ];

    expect(data.map((d) => Buffer.byteLength(d, 'utf8'))).toEqual([44, 44, 42, 54, 55, 56]);
  });

  it('a deleted rule never fires again, and its past expense stays in /month', async () => {
    const { tap, tapOn, send, tick, ruleId, recorded, clock, calls, lastMessageId } =
      await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    await tick('2026-11-01T08:00:00Z');
    await send('/recurring');
    const list = lastMessageId();

    await tapOn(`rec:r:${ruleId()}`, list);
    await tapOn('rec:del', list);
    await tapOn('rec:delok', list);
    await tick('2026-12-01T08:00:00Z');
    await tick('2027-01-01T08:00:00Z');

    expect(recorded()).toEqual([
      { amount_minor: 4500000, occurred_on: '2026-11-01', deleted_at: null },
    ]);
    clock.setTime(new Date('2026-11-15T10:00:00Z').getTime());
    calls.length = 0;
    await send('/month');
    expect(sent(calls)[0]?.text).toContain('45 000.00 RSD');
  });

  it('[Повторять] offers monthly, weekly and yearly from Thursday 1 October, with [« Назад]', async () => {
    const { tap, calls } = await rentBot();
    calls.length = 0;

    await tap(`rec:new:${EXPENSE_ID}`);

    expect(calls.find((c) => c.method === 'editMessageText')?.payload).toMatchObject({
      text:
        'Записано в «Личные расходы»: <b>45 000.00 RSD</b> — аренда\n' +
        'Как повторять? В этот день в 09:00 я сам запишу такую же трату.',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Каждый месяц, 1-го', callback_data: `rec:s:${EXPENSE_ID}:m` }],
          [{ text: 'Каждую неделю, по четвергам', callback_data: `rec:s:${EXPENSE_ID}:w` }],
          [{ text: 'Каждый год, 01.10', callback_data: `rec:s:${EXPENSE_ID}:y` }],
          [{ text: messages.backButton, callback_data: `exp:show:${EXPENSE_ID}` }],
        ],
      },
    });
  });

  it('a schedule makes the rule and says so under the card; a second tap makes none', async () => {
    const { tap, calls, db } = await rentBot();
    calls.length = 0;

    await tap(`rec:s:${EXPENSE_ID}:m`);
    await tap(`rec:s:${EXPENSE_ID}:m`);

    const edit = calls.find((c) => c.method === 'editMessageText')?.payload as { text: string };
    expect(edit.text).toContain(
      'Повторяется: каждый месяц, 1-го. Следующая запись — 1 ноября. Все правила: /recurring',
    );
    expect(db.prepare('SELECT COUNT(*) FROM recurring_rules').pluck().get()).toBe(1);
  });

  it('a weekly choice says so under the card', async () => {
    const { tap, calls } = await rentBot();
    calls.length = 0;

    await tap(`rec:s:${EXPENSE_ID}:w`);

    const edit = calls.find((c) => c.method === 'editMessageText')?.payload as { text: string };
    expect(edit.text).toContain(
      'Повторяется: каждую неделю, по четвергам. Следующая запись — 8 октября.',
    );
  });

  it('[Повторять] on someone else’s expense records no rule', async () => {
    const { bot, db } = await rentBot();

    await bot.handleUpdate(
      callbackUpdate({ updateId: 50, fromId: SECOND_ALLOWED_ID, data: `rec:s:${EXPENSE_ID}:m` }),
    );

    expect(db.prepare('SELECT COUNT(*) FROM recurring_rules').pluck().get()).toBe(0);
  });

  it('/recurring lists the rule with its money, schedule and next date', async () => {
    const { tap, send, calls } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    calls.length = 0;

    await send('/recurring');

    expect(calls[0]?.payload).toMatchObject({
      text: '<b>Регулярные траты</b>\n\nаренда — 45 000.00 RSD\nКаждый месяц, 1-го · следующая 1 ноября',
    });
  });

  it('/today on 1 November includes the rent recorded at 09:00', async () => {
    const { tap, send, calls, clock, tick } = await rentBot();
    await tap(`rec:s:${EXPENSE_ID}:m`);
    await tick('2026-11-01T08:00:00Z');
    clock.setTime(new Date('2026-11-01T10:00:00Z').getTime());
    calls.length = 0;

    await send('/today');

    expect(calls[0]?.payload).toMatchObject({
      text: '<b>Сегодня, 1 ноября — «Личные расходы»</b>\n45 000.00 RSD',
    });
  });

  // The rent bot with encryption switched on, the monthly rule made while unlocked, then locked.
  async function sealedRentBot() {
    const harness = await rentBot();
    const user = findUserByIdentity(harness.db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('setup: no user');
    const keyDeps = { db: harness.db, logger: silentLogger(), keys: harness.keys };
    const ledger = await sealPersonalLedger(keyDeps, user, harness.clock);
    await unlockPersonalLedger(keyDeps, user, harness.clock);
    await harness.tap(`rec:s:${EXPENSE_ID}:m`);
    harness.keys.lock(ledger.id);
    const unlock = () => unlockPersonalLedger(keyDeps, user, harness.clock);
    return { ...harness, unlock };
  }

  it('a sealed occurrence is recorded while locked, and its notice names neither amount nor description', async () => {
    const { tick, calls, db, ruleId, tap, unlock } = await sealedRentBot();
    calls.length = 0;

    await tick('2026-11-01T08:00:00Z');

    const expenseId = db
      .prepare("SELECT id FROM expenses WHERE source_key LIKE 'rec:%'")
      .pluck()
      .get() as ExpenseId;
    expect(sent(calls)).toEqual([
      expect.objectContaining({
        chat_id: ALLOWED_ID,
        text: 'Записана регулярная трата. Учёт зашифрован: сумма и описание видны после /unlock.',
        reply_markup: {
          inline_keyboard: [
            [{ text: messages.undoButton, callback_data: undoExpenseData(expenseId) }],
          ],
        },
      }),
    ]);
    expect(sent(calls)[0]?.text).not.toMatch(/45 000|аренда/);
    expect(
      db
        .prepare(
          "SELECT amount_minor, description, sealed_rule_id FROM expenses WHERE source_key LIKE 'rec:%'",
        )
        .get(),
    ).toEqual({ amount_minor: null, description: null, sealed_rule_id: ruleId() });

    await unlock();
    await tap(undoExpenseData(expenseId));
    expect(
      db.prepare('SELECT deleted_at IS NOT NULL FROM expenses WHERE id = ?').pluck().get(expenseId),
    ).toBe(1);
  });

  it('a sealed ask prompt offers [Записать] and [Пропустить], with no amount', async () => {
    const { tick, calls, askMode, ruleId, tap, db } = await sealedRentBot();
    askMode();
    calls.length = 0;

    await tick('2026-11-01T08:00:00Z');

    const id = ruleId();
    expect(sent(calls)).toEqual([
      expect.objectContaining({
        text: 'По расписанию на 1 ноября: регулярная трата из зашифрованного учёта. Записать?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Записать', callback_data: `rec:ok:${id}:2026-11-01` },
              { text: 'Пропустить', callback_data: `rec:skip:${id}:2026-11-01` },
            ],
          ],
        },
      }),
    ]);
    calls.length = 0;
    // The clock still reads 2 October, so the notice names the due date.
    await tap(`rec:ok:${id}:2026-11-01`);
    expect(calls.find((c) => c.method === 'editMessageText')?.payload).toMatchObject({
      text: 'Записана регулярная трата за 1 ноября. Учёт зашифрован: сумма и описание видны после /unlock.',
    });
    expect(
      db.prepare("SELECT sealed_rule_id FROM expenses WHERE source_key LIKE 'rec:%'").pluck().get(),
    ).toBe(id);
  });

  it('/recurring shows a locked sealed rule by its schedule only', async () => {
    const { send, calls } = await sealedRentBot();
    calls.length = 0;

    await send('/recurring');

    expect(calls[0]?.payload).toMatchObject({
      text: '<b>Регулярные траты</b>\n\n🔒 Зашифрованная трата\nКаждый месяц, 1-го · следующая 1 ноября',
    });
  });

  it('the reminder prompt says its text stays plaintext in a sealed ledger', async () => {
    const { send, tapOn, lastMessageId, calls } = await sealedRentBot();
    await send('/recurring');
    calls.length = 0;

    await tapOn('rec:rem', lastMessageId());

    expect(calls.find((c) => c.method === 'editMessageText')?.payload).toMatchObject({
      text: messages.reminderTextPromptSealed,
    });
  });
});

interface SentDocument {
  readonly chatId: unknown;
  readonly filename: string | undefined;
  readonly bytes: Buffer;
}

// The documents the bot sent, alone or in an album, with the bytes each InputFile holds.
async function sentDocuments(calls: readonly ApiCall[]): Promise<SentDocument[]> {
  const files = calls.flatMap((call) => {
    if (call.method === 'sendDocument') {
      const payload = call.payload as { chat_id: unknown; document: InputFile };
      return [{ chatId: payload.chat_id, file: payload.document }];
    }
    if (call.method === 'sendMediaGroup') {
      const payload = call.payload as { chat_id: unknown; media: { media: InputFile }[] };
      return payload.media.map((item) => ({ chatId: payload.chat_id, file: item.media }));
    }
    return [];
  });
  return Promise.all(
    files.map(async ({ chatId, file }) => {
      const raw = await file.toRaw();
      if (!(raw instanceof Uint8Array)) throw new Error('document is not in memory');
      return { chatId, filename: file.filename, bytes: Buffer.from(raw) };
    }),
  );
}

const EXPENSE_HEADER =
  'Дата;Время;Сумма;Валюта;Сумма в RSD;Категория;Описание;Метки;Магазин;Чек;ID';

// The deflated bytes of a zip entry, found by its local header's name.
function zipEntry(zip: Buffer, name: string): Buffer {
  for (let at = 0; zip.readUInt32LE(at) === 0x04034b50;) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const dataAt = at + 30 + nameLength + zip.readUInt16LE(at + 28);
    if (zip.toString('utf8', at + 30, at + 30 + nameLength) === name) {
      return zip.subarray(dataAt, dataAt + size);
    }
    at = dataAt + size;
  }
  throw new Error(`no zip entry ${name}`);
}

// A CSV's lines after the BOM, without the final CRLF.
function csvLines(bytes: Buffer): string[] {
  return bytes.subarray(3).toString('utf8').split('\r\n').slice(0, -1);
}

describe('/export (ADR-0026)', () => {
  const rangeKeyboard = {
    inline_keyboard: [
      [
        { text: 'Этот месяц', callback_data: 'xp:r:tm' },
        { text: 'Прошлый месяц', callback_data: 'xp:r:pm' },
      ],
      [
        { text: 'Этот год', callback_data: 'xp:r:ty' },
        { text: 'Всё время', callback_data: 'xp:r:all' },
      ],
    ],
  };
  const formatKeyboard = (range: string) => ({
    inline_keyboard: [
      [
        { text: 'CSV', callback_data: `xp:f:${range}:csv` },
        { text: 'Excel', callback_data: `xp:f:${range}:xlsx` },
      ],
      [{ text: '← Назад', callback_data: 'xp:back' }],
    ],
  });

  async function withTwoExpenses() {
    const harness = createTestBot();
    await harness.bot.handleUpdate(textUpdate({ updateId: 1, messageId: 1, text: '450 кофе' }));
    await harness.bot.handleUpdate(
      textUpdate({ updateId: 2, messageId: 2, text: '12,50 EUR такси' }),
    );
    harness.calls.length = 0;
    return harness;
  }

  it('asks for the range, then the format in place, and [← Назад] goes back', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/export' }));
    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: 'xp:r:pm', messageId: 5 }));
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:back', messageId: 5 }));

    expect(calls.map((call) => call.method)).toEqual([
      'sendMessage',
      'answerCallbackQuery',
      'editMessageText',
      'answerCallbackQuery',
      'editMessageText',
    ]);
    expect(calls[0]?.payload).toMatchObject({
      text: 'Что выгрузить?',
      reply_markup: rangeKeyboard,
    });
    expect(calls[2]?.payload).toMatchObject({
      message_id: 5,
      text: 'Формат файла?',
      reply_markup: formatKeyboard('pm'),
    });
    expect(calls[4]?.payload).toMatchObject({
      text: 'Что выгрузить?',
      reply_markup: rangeKeyboard,
    });
  });

  const idOf = (db: Db, description: string) =>
    db.prepare('SELECT id FROM expenses WHERE description = ?').pluck().get(description) as string;

  it('sends a CSV of 450 кофе and 12,50 EUR такси for all time, then closes the picker', async () => {
    const { bot, calls, db } = await withTwoExpenses();

    await bot.handleUpdate(textUpdate({ updateId: 3, messageId: 3, text: '/export' }));
    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: 'xp:r:all', messageId: 5 }));
    await bot.handleUpdate(callbackUpdate({ updateId: 5, data: 'xp:f:all:csv', messageId: 5 }));

    const documents = await sentDocuments(calls);
    expect(documents).toHaveLength(1);
    const [csv] = documents;
    expect(csv?.chatId).toBe(ALLOWED_ID);
    expect(csv?.filename).toBe('expenses-all.csv');
    expect([...(csv?.bytes.subarray(0, 3) ?? [])]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = csvLines(csv?.bytes ?? Buffer.alloc(0));
    // A personal ledger: no Автор column. No EUR rate is stored, so its converted cell is empty.
    expect(lines[0]).toBe(EXPENSE_HEADER);
    expect(lines.slice(1)).toEqual([
      `2026-09-29;23:50;450,00;RSD;450,00;Кафе и рестораны;кофе;;;;${idOf(db, 'кофе')}`,
      expect.stringMatching(
        new RegExp(`^2026-09-29;23:50;12,50;EUR;;[^;]*;такси;;;;${idOf(db, 'такси')}$`),
      ),
    ]);
    const edits = calls.filter((call) => call.method === 'editMessageText');
    expect(edits.at(-1)?.payload).toMatchObject({
      message_id: 5,
      text: 'Готово: 2 расхода за всё время',
    });
    expect(edits.at(-1)?.payload).not.toHaveProperty('reply_markup');
  });

  it('sends [Excel] as one expenses-all.xlsx zip, and closes the picker', async () => {
    const { bot, calls } = await withTwoExpenses();

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:f:all:xlsx', messageId: 5 }));

    const documents = await sentDocuments(calls);
    expect(documents.map((doc) => doc.filename)).toEqual(['expenses-all.xlsx']);
    const bytes = documents[0]?.bytes ?? Buffer.alloc(0);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    // Both expenses as numeric cells in the sheet, the date as text.
    const sheet = inflateRawSync(zipEntry(bytes, 'xl/worksheets/sheet1.xml')).toString('utf8');
    expect(sheet).toContain('<v>450.00</v>');
    expect(sheet).toContain('<v>12.50</v>');
    expect(sheet).toContain('<t xml:space="preserve">2026-09-29</t>');
    expect(calls.at(-1)?.payload).toMatchObject({ text: 'Готово: 2 расхода за всё время' });
  });

  it('leaves a soft-deleted expense out of every range', async () => {
    const { bot, calls, db } = await withTwoExpenses();
    const id = db.prepare("SELECT id FROM expenses WHERE description = 'такси'").pluck().get();
    softDeleteExpense(db, id as ExpenseId, new Date('2026-09-29T22:00:00Z'));

    for (const [i, range] of ['tm', 'ty', 'all'].entries()) {
      calls.length = 0;
      await bot.handleUpdate(
        callbackUpdate({ updateId: 10 + i, data: `xp:f:${range}:csv`, messageId: 20 + i }),
      );
      const [csv] = await sentDocuments(calls);
      expect(csvLines(csv?.bytes ?? Buffer.alloc(0))).toEqual([
        EXPENSE_HEADER,
        `2026-09-29;23:50;450,00;RSD;450,00;Кафе и рестораны;кофе;;;;${idOf(db, 'кофе')}`,
      ]);
    }
  });

  it('answers a range with no expenses with the empty text and sends no document', async () => {
    const { bot, calls } = await withTwoExpenses();

    // Last month is August: both expenses are on 29 September.
    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:f:pm:csv', messageId: 5 }));

    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(calls[1]?.payload).toMatchObject({
      message_id: 5,
      text: 'За этот период расходов нет',
    });
    expect(calls[1]?.payload).not.toHaveProperty('reply_markup');
  });

  it('sends one document for two format taps when the second arrives while the first builds', async () => {
    const { bot, calls } = await withTwoExpenses();
    const gate = Promise.withResolvers<undefined>();
    const sending = Promise.withResolvers<undefined>();
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendDocument') {
        sending.resolve(undefined);
        await gate.promise;
      }
      return prev(method, payload, signal);
    });

    const first = bot.handleUpdate(
      callbackUpdate({ updateId: 3, data: 'xp:f:all:csv', messageId: 5 }),
    );
    await sending.promise;
    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: 'xp:f:all:csv', messageId: 5 }));
    gate.resolve(undefined);
    await first;

    expect((await sentDocuments(calls)).map((doc) => doc.filename)).toEqual(['expenses-all.csv']);
    expect(calls.filter((call) => call.method === 'answerCallbackQuery')).toHaveLength(2);
  });

  // Inserts a live expense into the harness user's active ledger.
  function insertExpense(db: Db, id: string, amountMinor: number, description: string) {
    const owner = db.prepare('SELECT id, active_ledger_id FROM users').get() as {
      id: string;
      active_ledger_id: string;
    };
    insertExpenseOrGetExisting(db, {
      id: id as ExpenseId,
      ledgerId: owner.active_ledger_id as LedgerId,
      createdBy: owner.id as UserId,
      amountMinor,
      currency: 'RSD',
      description,
      occurredAt: new Date('2026-09-29T12:00:00Z'),
      occurredOn: '2026-09-29' as LocalDate,
      sourceKey: `test:${id}`,
      createdAt: new Date('2026-09-29T12:00:00Z'),
    });
  }

  it.each([
    [1171234, '1171,23'],
    [1171235, '1171,24'],
  ])('exports 10,00 EUR at an EUR rate of %i as %s in Сумма в RSD', async (middleE4, cell) => {
    const { bot, calls, db } = createTestBot();
    const day = '2026-09-29' as LocalDate;
    const fetchedAt = new Date('2026-09-29T08:00:00Z');
    storeFxList(
      db,
      { listDate: day, listNumber: 1, rates: [{ currency: 'EUR', unit: 1, middleE4 }] },
      fetchedAt,
    );
    setFxDay(db, day, day, fetchedAt);
    await bot.handleUpdate(textUpdate({ updateId: 1, messageId: 1, text: '10 EUR такси' }));

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: 'xp:f:all:csv', messageId: 5 }));

    const [csv] = await sentDocuments(calls);
    const fields = csvLines(csv?.bytes ?? Buffer.alloc(0))[1]?.split(';');
    expect(fields?.slice(2, 5)).toEqual(['10,00', 'EUR', cell]);
  });

  it('sends the expenses and the receipt items as one album, the items keyed by the expense ID', async () => {
    const { bot, calls, db } = await withTwoExpenses();
    const expenseId = '00000000-0000-4000-8000-0000000000aa';
    const receiptId = 'receipt-1' as ReceiptId;
    insertExpense(db, expenseId, 82912, 'Чек');
    insertReceipt(db, {
      id: receiptId,
      expenseId: expenseId as ExpenseId,
      country: 'RS',
      fiscalId: 'F1',
      merchantKey: 'rs:1',
      verifyUrl: 'https://suf.example/v/?vl=synthetic',
      issuedAt: new Date('2026-09-29T12:00:00Z'),
      createdAt: new Date('2026-09-29T12:00:00Z'),
    });
    db.transaction(() => {
      markReceiptFetched(db, receiptId, 'Test Market');
      insertReceiptItems(db, receiptId, [
        { name: 'Хлеб', quantity: '1', totalMinor: 9999 },
        { name: 'Сыр', quantity: '0.535', totalMinor: 52913 },
        { name: 'Вода', quantity: '2', totalMinor: 20000 },
      ]);
    })();

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:f:all:csv', messageId: 5 }));

    expect(calls.filter((call) => call.method === 'sendMediaGroup')).toHaveLength(1);
    const [expenses, items] = await sentDocuments(calls);
    expect(expenses?.filename).toBe('expenses-all.csv');
    expect(items?.filename).toBe('receipt-items-all.csv');
    const receiptRow = csvLines(expenses?.bytes ?? Buffer.alloc(0)).find((line) =>
      line.endsWith(expenseId),
    );
    expect(receiptRow?.split(';').slice(8)).toEqual([
      'Test Market',
      'https://suf.example/v/?vl=synthetic',
      expenseId,
    ]);
    expect(csvLines(items?.bytes ?? Buffer.alloc(0))).toEqual([
      'ID расхода;Дата;Магазин;№;Наименование;Количество;Сумма;Валюта',
      `${expenseId};2026-09-29;Test Market;1;Хлеб;1;99,99;RSD`,
      `${expenseId};2026-09-29;Test Market;2;Сыр;0,535;529,13;RSD`,
      `${expenseId};2026-09-29;Test Market;3;Вода;2;200,00;RSD`,
    ]);
  });

  it('puts the receipt items on a second sheet of the one xlsx', async () => {
    const { bot, calls, db } = await withTwoExpenses();
    const expenseId = '00000000-0000-4000-8000-0000000000aa';
    const receiptId = 'receipt-1' as ReceiptId;
    insertExpense(db, expenseId, 82912, 'Чек');
    insertReceipt(db, {
      id: receiptId,
      expenseId: expenseId as ExpenseId,
      country: 'RS',
      fiscalId: 'F1',
      merchantKey: 'rs:1',
      verifyUrl: 'https://suf.example/v/?vl=synthetic',
      issuedAt: new Date('2026-09-29T12:00:00Z'),
      createdAt: new Date('2026-09-29T12:00:00Z'),
    });
    insertReceiptItems(db, receiptId, [{ name: 'Сыр', quantity: '0.535', totalMinor: 52913 }]);

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:f:all:xlsx', messageId: 5 }));

    const documents = await sentDocuments(calls);
    expect(documents.map((doc) => doc.filename)).toEqual(['expenses-all.xlsx']);
    const bytes = documents[0]?.bytes ?? Buffer.alloc(0);
    const workbook = inflateRawSync(zipEntry(bytes, 'xl/workbook.xml')).toString('utf8');
    expect([...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'Расходы',
      'Позиции чеков',
    ]);
    const items = inflateRawSync(zipEntry(bytes, 'xl/worksheets/sheet2.xml')).toString('utf8');
    expect(items).toContain(`<t xml:space="preserve">${expenseId}</t>`);
    expect(items).toContain('<v>529.13</v>');
  });

  it('sends exactly one document for a range without receipts', async () => {
    const { bot, calls } = await withTwoExpenses();

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:f:all:csv', messageId: 5 }));

    expect(calls.filter((call) => call.method === 'sendDocument')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'sendMediaGroup')).toHaveLength(0);
  });

  it("exports a description =SUM(A1) as '=SUM(A1), and never prefixes an amount cell", async () => {
    const { bot, calls, db } = await withTwoExpenses();
    insertExpense(db, '00000000-0000-4000-8000-0000000000bb', 500, '=SUM(A1)');

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'xp:f:all:csv', messageId: 5 }));

    const [csv] = await sentDocuments(calls);
    const rows = csvLines(csv?.bytes ?? Buffer.alloc(0))
      .slice(1)
      .map((line) => line.split(';'));
    expect(rows.map((row) => row[6])).toContain("'=SUM(A1)");
    for (const row of rows) {
      expect(row[2]).toMatch(/^\d/);
      expect(row[4] ?? '').not.toMatch(/^'/);
    }
  });

  it('sends nothing for a locked sealed ledger, and the plaintext once unlocked', async () => {
    const { bot, calls, db, keys } = await withTwoExpenses();
    const user = findUserByIdentity(db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('setup: no user');
    const keyDeps = { db, logger: silentLogger(), keys };
    await sealPersonalLedger(keyDeps, user, new Date('2026-09-29T22:10:00Z'));

    await bot.handleUpdate(textUpdate({ updateId: 3, messageId: 3, text: '/export' }));
    await bot.handleUpdate(callbackUpdate({ updateId: 4, data: 'xp:f:all:csv', messageId: 5 }));

    expect(calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    expect(calls[0]?.payload).toMatchObject({ text: messages.ledgerLocked });
    expect(calls[1]?.payload).toMatchObject({ text: messages.ledgerLockedToast });

    await unlockPersonalLedger(keyDeps, user, new Date('2026-09-29T22:10:00Z'));
    calls.length = 0;
    await bot.handleUpdate(textUpdate({ updateId: 5, messageId: 6, text: '/export' }));
    await bot.handleUpdate(callbackUpdate({ updateId: 6, data: 'xp:f:all:csv', messageId: 7 }));

    expect(calls[0]?.payload).toMatchObject({ text: messages.exportRangePrompt(true) });
    const [csv] = await sentDocuments(calls);
    const rows = csvLines(csv?.bytes ?? Buffer.alloc(0))
      .slice(1)
      .map((line) => line.split(';'));
    expect(rows.map((row) => [row[2], row[3], row[6]])).toEqual([
      ['450,00', 'RSD', 'кофе'],
      ['12,50', 'EUR', 'такси'],
    ]);
  });

  it('is in the command menu and the help text', () => {
    expect(messages.commands.map((c) => c.command)).toContain('export');
    expect(messages.help).toContain('/export');
    expect(messages.groupHelp).toContain('/export');
  });
});

describe('debts (Plan 0013)', () => {
  const SENT_AT = new Date('2026-10-02T09:59:00Z');

  // Sent messages get ids, so /debts becomes the anchor; every update has its own id.
  function debtsBot() {
    const harness = createTestBot({ now: new Date('2026-10-02T10:00:00Z') });
    let messageId = 100;
    harness.bot.api.config.use(async (prev, method, payload, signal) => {
      const answer = await prev(method, payload, signal);
      if (method !== 'sendMessage') return answer;
      const chat = { id: (payload as { chat_id: number }).chat_id, type: 'private' };
      return { ok: true, result: { message_id: ++messageId, date: 0, chat, text: '' } as never };
    });
    let updateId = 0;
    const textOf = (text: string): Update => {
      const id = ++updateId;
      return textUpdate({ updateId: id, messageId: id, text, date: SENT_AT });
    };
    const handle = (update: Update) => harness.bot.handleUpdate(update);
    const say = (text: string) => handle(textOf(text));
    const tapOf = (data: string, message: number): Update =>
      callbackUpdate({ updateId: ++updateId, data, messageId: message });
    const tapOn = (data: string, message: number) => handle(tapOf(data, message));
    // /debts, returning the anchor it sent.
    const openDebts = async () => {
      await say('/debts');
      return messageId;
    };
    const lastSent = () =>
      harness.calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload as
        { text: string; reply_markup?: unknown } | undefined;
    const lastEdit = () =>
      harness.calls.filter((c) => c.method === 'editMessageText').at(-1)?.payload as
        { text: string; reply_markup?: unknown } | undefined;
    const ops = () =>
      harness.db
        .prepare('SELECT kind, amount_minor, currency, occurred_on FROM debt_ops ORDER BY rowid')
        .all();
    const debtsText = async () => {
      await openDebts();
      return lastSent()?.text;
    };
    // [Я дал в долг], the amount, then a typed name or a picked person id.
    const lend = async (amount: string, person: string | number) => {
      const anchor = await openDebts();
      await tapOn('dbt:new:l', anchor);
      await say(amount);
      if (typeof person === 'string') await say(person);
      else await tapOn(`dbt:pick:${person}`, anchor);
      return anchor;
    };
    const lastMessageId = () => messageId;
    return {
      ...harness,
      lastMessageId,
      textOf,
      handle,
      say,
      tapOf,
      tapOn,
      openDebts,
      lastSent,
      lastEdit,
      ops,
      debtsText,
      lend,
    };
  }

  it('[Я дал в долг], 5000, «Петя» records lend 500000 RSD, and /debts shows it', async () => {
    const { lend, ops, lastEdit, debtsText, db } = debtsBot();

    await lend('5000', 'Петя');

    expect(ops()).toEqual([
      { kind: 'lend', amount_minor: 500000, currency: 'RSD', occurred_on: '2026-10-02' },
    ]);
    const opId = db.prepare('SELECT id FROM debt_ops').pluck().get() as string;
    expect(lastEdit()).toMatchObject({
      text: 'Записано: вы дали в долг 5 000.00 RSD.\nПетя — должен вам 5 000.00 RSD',
      reply_markup: { inline_keyboard: [[{ text: 'Удалить', callback_data: `dbt:del:${opId}` }]] },
    });
    expect(await debtsText()).toBe('<b>Долги</b>\nПетя — должен вам 5 000.00 RSD');
  });

  it('a second lend of 20 EUR to Петя, picked by button, adds a separate EUR line', async () => {
    const { lend, ops, lastEdit, debtsText, openDebts, tapOn, say } = debtsBot();
    await lend('5000', 'Петя');
    const anchor = await openDebts();
    await tapOn('dbt:new:l', anchor);
    await say('20 EUR');

    expect(lastEdit()).toMatchObject({
      text: 'Кому вы дали 20.00 EUR? Выберите человека или отправьте имя.',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Петя', callback_data: 'dbt:pick:1' }],
          [{ text: 'Отмена', callback_data: 'flow:cancel' }],
        ],
      },
    });
    await tapOn('dbt:pick:1', anchor);

    expect(ops()).toEqual([
      expect.objectContaining({ kind: 'lend', amount_minor: 500000, currency: 'RSD' }),
      expect.objectContaining({ kind: 'lend', amount_minor: 2000, currency: 'EUR' }),
    ]);
    expect(await debtsText()).toBe(
      '<b>Долги</b>\nПетя — должен вам 20.00 EUR\nПетя — должен вам 5 000.00 RSD',
    );
  });

  it('typing «петя» as a new name reuses Петя', async () => {
    const { lend, db, debtsText } = debtsBot();
    await lend('5000', 'Петя');
    await lend('1000', 'петя');

    expect(db.prepare('SELECT name FROM debt_people').pluck().all()).toEqual(['Петя']);
    expect(await debtsText()).toBe('<b>Долги</b>\nПетя — должен вам 6 000.00 RSD');
  });

  it('a redelivered final update records one operation, typed or tapped', async () => {
    const { openDebts, tapOn, say, textOf, tapOf, handle, ops } = debtsBot();
    let anchor = await openDebts();
    await tapOn('dbt:new:l', anchor);
    await say('5000');
    const typed = textOf('Петя');
    await handle(typed);
    await handle(typed);

    anchor = await openDebts();
    await tapOn('dbt:new:l', anchor);
    await say('100');
    const tapped = tapOf('dbt:pick:1', anchor);
    await handle(tapped);
    await handle(tapped);

    expect(ops()).toEqual([
      expect.objectContaining({ amount_minor: 500000 }),
      expect.objectContaining({ amount_minor: 10000 }),
    ]);
  });

  it('/today and /month totals are unchanged by a debt', async () => {
    const { say, lend, lastSent, db } = debtsBot();
    await say('450 кофе');
    const totals = async () => {
      await say('/today');
      const today = lastSent()?.text;
      await say('/month');
      return [today, lastSent()?.text];
    };
    const before = await totals();

    await lend('5000', 'Петя');

    expect(await totals()).toEqual(before);
    expect(before[0]).toContain('450.00 RSD');
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
  });

  // Opens the person's card from /debts, returning the anchor.
  async function openCard(bot: ReturnType<typeof debtsBot>, personId: number) {
    const anchor = await bot.openDebts();
    await bot.tapOn(`dbt:p:${personId}`, anchor);
    return anchor;
  }

  it('[Мне вернули] 2000 of 5000 leaves 3000; [Весь долг] clears it, and the card keeps the history', async () => {
    const bot = debtsBot();
    await bot.lend('5000', 'Петя');
    let anchor = await openCard(bot, 1);
    await bot.tapOn('dbt:rp:1:t', anchor);
    expect(bot.lastEdit()).toMatchObject({
      text: 'Сколько вернули? Весь долг — 5 000.00 RSD. Сумма в RSD.',
    });
    await bot.say('2000');
    expect(await bot.debtsText()).toBe('<b>Долги</b>\nПетя — должен вам 3 000.00 RSD');

    anchor = await openCard(bot, 1);
    await bot.tapOn('dbt:rp:1:t', anchor);
    await bot.tapOn('dbt:all', anchor);

    expect(bot.ops()).toEqual([
      expect.objectContaining({ kind: 'lend', amount_minor: 500000 }),
      expect.objectContaining({ kind: 'repaid_to_me', amount_minor: 200000 }),
      expect.objectContaining({ kind: 'repaid_to_me', amount_minor: 300000 }),
    ]);
    expect(await bot.debtsText()).toBe(messages.debtsScreen([]));
    await openCard(bot, 1);
    expect(bot.lastEdit()).toMatchObject({
      text:
        '<b>Петя</b>\n\nДолга нет.\n\n<b>Последние операции</b>\n' +
        '2 окт · вам вернули 3 000.00 RSD\n2 окт · вам вернули 2 000.00 RSD\n' +
        '2 окт · вы дали в долг 5 000.00 RSD',
      reply_markup: { inline_keyboard: [[{ text: '« Назад', callback_data: 'dbt:list' }]] },
    });
  });

  it('with 3000 RSD and 20 EUR owed, [Мне вернули] asks the currency; 20 USD and 25 EUR are refused', async () => {
    const bot = debtsBot();
    await bot.lend('3000', 'Петя');
    await bot.lend('20 EUR', 1);
    const anchor = await openCard(bot, 1);
    await bot.tapOn('dbt:rp:1:t', anchor);
    expect(bot.lastEdit()).toMatchObject({
      text: 'Какой долг вам вернули?',
      reply_markup: {
        inline_keyboard: [
          [{ text: '20.00 EUR', callback_data: 'dbt:rc:1:EUR' }],
          [{ text: '3 000.00 RSD', callback_data: 'dbt:rc:1:RSD' }],
          [{ text: '« Назад', callback_data: 'dbt:p:1' }],
        ],
      },
    });
    await bot.tapOn('dbt:rc:1:EUR', anchor);
    await bot.say('20 USD');
    expect(bot.lastEdit()?.text).toBe(
      'Долг в EUR: вернуть его можно только в EUR.\nСколько вернули? Весь долг — 20.00 EUR. Сумма в EUR.',
    );
    await bot.say('25');
    expect(bot.lastEdit()?.text).toBe(
      'Это больше долга: 20.00 EUR.\nСколько вернули? Весь долг — 20.00 EUR. Сумма в EUR.',
    );

    expect(bot.ops()).toHaveLength(2);
  });

  it('borrowing 20 EUR from Аня shows «вы должны»; [Я вернул] 20 clears it', async () => {
    const bot = debtsBot();
    const anchor = await bot.openDebts();
    await bot.tapOn('dbt:new:b', anchor);
    await bot.say('20 EUR');
    await bot.say('Аня');
    expect(bot.ops()).toEqual([
      expect.objectContaining({ kind: 'borrow', amount_minor: 2000, currency: 'EUR' }),
    ]);
    expect(await bot.debtsText()).toBe('<b>Долги</b>\nАня — вы должны 20.00 EUR');

    const card = await openCard(bot, 1);
    await bot.tapOn('dbt:rp:1:i', card);
    await bot.say('20');

    expect(bot.ops()).toContainEqual(
      expect.objectContaining({ kind: 'i_repaid', amount_minor: 2000, currency: 'EUR' }),
    );
    expect(await bot.debtsText()).toBe(messages.debtsScreen([]));
  });

  it('deleting the 2000 repayment brings Петя back to 5 000.00 RSD; a second tap answers «Уже удалено»', async () => {
    const bot = debtsBot();
    await bot.lend('5000', 'Петя');
    const anchor = await openCard(bot, 1);
    await bot.tapOn('dbt:rp:1:t', anchor);
    await bot.say('2000');
    const repayment = bot.db
      .prepare("SELECT id FROM debt_ops WHERE kind = 'repaid_to_me'")
      .pluck()
      .get() as string;

    await bot.tapOn(`dbt:del:${repayment}`, anchor);
    await bot.tapOn(`dbt:del:${repayment}`, anchor);

    const toasts = bot.calls
      .filter((c) => c.method === 'answerCallbackQuery')
      .map((c) => (c.payload as { text?: string }).text);
    expect(toasts.slice(-2)).toEqual(['Удалено', 'Уже удалено']);
    expect(await bot.debtsText()).toBe('<b>Долги</b>\nПетя — должен вам 5 000.00 RSD');
  });

  describe('splitting a bill with /N', () => {
    const expenses = (db: Db) =>
      db
        .prepare(
          'SELECT id, amount_minor, description, occurred_on FROM expenses WHERE deleted_at IS NULL',
        )
        .all() as { id: string; amount_minor: number; description: string; occurred_on: string }[];
    const lends = (db: Db) =>
      db
        .prepare("SELECT amount_minor, currency, expense_id FROM debt_ops WHERE kind = 'lend'")
        .all();

    it('1200 кафе /3 records 40000 and, with two names typed, two lends of 40000', async () => {
      const bot = debtsBot();
      await bot.say('1200 кафе /3');
      const picker = bot.lastMessageId();
      expect(bot.lastSent()?.text).toBe(
        'Кто должен вам по 400.00 RSD? Выберите 2 — кнопками или отправьте имя.',
      );
      await bot.say('Аня');
      await bot.say('Петя');
      await bot.tapOn('dbt:spok', picker);

      const [expense] = expenses(bot.db);
      expect(expense?.amount_minor).toBe(40000);
      expect(lends(bot.db)).toEqual([
        { amount_minor: 40000, currency: 'RSD', expense_id: expense?.id },
        { amount_minor: 40000, currency: 'RSD', expense_id: expense?.id },
      ]);
      expect(bot.lastEdit()?.text).toBe(
        'Записано: по 400.00 RSD должны вам Аня, Петя. Все долги: /debts.',
      );
    });

    it('1000 кафе /3 records 33334 and two lends of 33333, which sum to 100000', async () => {
      const bot = debtsBot();
      await bot.say('1000 кафе /3');
      const picker = bot.lastMessageId();
      const card = bot.calls.filter((c) => c.method === 'sendMessage').at(-2)?.payload as {
        text: string;
      };
      expect(card.text).toContain('Это ваша доля из 1 000.00 RSD на 3.');
      await bot.say('Аня');
      await bot.say('Петя');
      await bot.tapOn('dbt:spok', picker);

      const share = expenses(bot.db)[0]?.amount_minor ?? 0;
      const parts = (lends(bot.db) as { amount_minor: number }[]).map((l) => l.amount_minor);
      expect(share).toBe(33334);
      expect(parts).toEqual([33333, 33333]);
      expect(share + (parts[0] ?? 0) + (parts[1] ?? 0)).toBe(100000);
    });

    it('1000 кафе /3 вчера dates the expense yesterday, described «кафе»', async () => {
      const bot = debtsBot();
      await bot.say('1000 кафе /3 вчера');

      expect(expenses(bot.db)).toEqual([
        expect.objectContaining({
          amount_minor: 33334,
          description: 'кафе',
          occurred_on: '2026-10-01',
        }),
      ]);
    });

    it('/1, /21 and /3 /2 are refused and record nothing', async () => {
      const bot = debtsBot();
      for (const text of ['1000 кафе /1', '1000 кафе /21', '1000 кафе /3 /2']) {
        await bot.say(text);
        expect(bot.lastSent()?.text, text).toBe(messages.invalidAmount);
      }
      expect(expenses(bot.db)).toEqual([]);
    });

    it('[Готово] is inert with 1 person chosen and works with 2', async () => {
      const bot = debtsBot();
      await bot.lend('1', 'Аня');
      await bot.lend('1', 'Петя');
      await bot.say('1000 кафе /3');
      const picker = bot.lastMessageId();
      await bot.tapOn('dbt:sp:1', picker);
      await bot.tapOn('dbt:spok', picker);
      expect(lends(bot.db)).toHaveLength(2);
      expect(bot.lastEdit()).toMatchObject({
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✓ Аня', callback_data: 'dbt:sp:1' },
              { text: 'Петя', callback_data: 'dbt:sp:2' },
            ],
            [
              { text: 'Готово (1/2)', callback_data: 'dbt:spok' },
              { text: 'Пропустить', callback_data: 'dbt:spx' },
            ],
          ],
        },
      });

      await bot.tapOn('dbt:sp:2', picker);
      await bot.tapOn('dbt:spok', picker);
      expect(lends(bot.db)).toEqual([
        expect.objectContaining({ amount_minor: 100 }),
        expect.objectContaining({ amount_minor: 100 }),
        expect.objectContaining({ amount_minor: 33333 }),
        expect.objectContaining({ amount_minor: 33333 }),
      ]);
    });

    it('[Пропустить] leaves the 33334 expense and no debts', async () => {
      const bot = debtsBot();
      await bot.say('1000 кафе /3');
      await bot.tapOn('dbt:spx', bot.lastMessageId());

      expect(expenses(bot.db)).toEqual([expect.objectContaining({ amount_minor: 33334 })]);
      expect(bot.ops()).toEqual([]);
      expect(bot.lastEdit()?.text).toBe(messages.splitSkipped);
    });

    it('a redelivered 1000 кафе /3 records one expense and starts one picker', async () => {
      const bot = debtsBot();
      const update = bot.textOf('1000 кафе /3');
      await bot.handle(update);
      await bot.handle(update);

      expect(expenses(bot.db)).toHaveLength(1);
      const pickers = bot.calls.filter((c) =>
        (c.payload as { text?: string }).text?.startsWith('Кто должен вам'),
      );
      expect(pickers).toHaveLength(1);
    });
  });

  describe('in a sealed personal ledger (ADR-0020)', () => {
    // The debts bot with encryption on, unlocked; `lock` and `unlock` switch it.
    async function sealedDebtsBot() {
      const bot = debtsBot();
      await bot.say('/start');
      const user = findUserByIdentity(bot.db, 'telegram', String(ALLOWED_ID));
      if (user === undefined) throw new Error('setup: no user');
      const keyDeps = { db: bot.db, logger: silentLogger(), keys: bot.keys };
      const ledger = await sealPersonalLedger(keyDeps, user, SENT_AT);
      const unlock = () => unlockPersonalLedger(keyDeps, user, SENT_AT);
      await unlock();
      return { ...bot, unlock, lock: () => bot.keys.lock(ledger.id) };
    }

    it('a lend to «Петя» stores no name bytes and no amount; locked /debts answers the locked message, unlocked shows the balance', async () => {
      const bot = await sealedDebtsBot();
      await bot.lend('5000', 'Петя');

      const people = bot.db.prepare('SELECT * FROM debt_people').all() as Record<string, unknown>[];
      expect(people).toHaveLength(1);
      for (const value of Object.values(people[0] ?? {})) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        expect(bytes.includes(Buffer.from('Петя', 'utf8'))).toBe(false);
      }
      expect(bot.db.prepare('SELECT kind, amount_minor, currency FROM debt_ops').all()).toEqual([
        { kind: null, amount_minor: null, currency: null },
      ]);

      bot.lock();
      expect(await bot.debtsText()).toBe(messages.ledgerLocked);
      await bot.unlock();
      expect(await bot.debtsText()).toBe('<b>Долги</b>\nПетя — должен вам 5 000.00 RSD');
    });

    it('while locked, a tap on an open debts screen answers the locked toast and records nothing', async () => {
      const bot = await sealedDebtsBot();
      const anchor = await bot.openDebts();
      bot.lock();

      await bot.tapOn('dbt:new:l', anchor);

      const toast = bot.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload;
      expect(toast).toMatchObject({ text: messages.ledgerLockedToast });
      expect(bot.db.prepare('SELECT kind FROM flow_sessions').pluck().all()).not.toContain(
        'debtAmount',
      );
    });

    it('a locked 1000 кафе /3 records the share and answers splitLocked, with no picker', async () => {
      const bot = await sealedDebtsBot();
      bot.lock();

      await bot.say('1000 кафе /3');

      expect(bot.lastSent()?.text).toBe(messages.splitLocked);
      expect(bot.db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
      expect(bot.ops()).toEqual([]);
      await bot.unlock();
      await bot.say('/today');
      expect(bot.lastSent()?.text).toContain('333.34 RSD');
    });
  });

  it('[Удалить] carries 44 bytes of callback data', () => {
    expect(Buffer.byteLength(debtDeleteData('00000000-0000-4000-8000-000000000001'))).toBe(44);
  });
});

describe('bank statements (Plan 0027)', () => {
  const SENT = new Date('2026-10-02T09:00:00Z');
  // The download goes through fetch; it serves the files registered by file id.
  const realFetch = globalThis.fetch;
  let files: Map<string, Uint8Array>;
  let fetched: string[];
  beforeEach(() => {
    files = new Map();
    fetched = [];
    globalThis.fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      const body = files.get(url.slice(url.lastIndexOf('/') + 1));
      return Promise.resolve(
        body === undefined ? new Response('gone', { status: 404 }) : new Response(body),
      );
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function statementBot(options: { logLevel?: 'info' | 'silent' } = {}) {
    const harness = createTestBot({ now: SENT, ...options });
    let updateId = 0;
    harness.bot.api.config.use((prev, method, payload, signal) => {
      if (method !== 'getFile') return prev(method, payload, signal);
      const { file_id } = payload as { file_id: string };
      return Promise.resolve({
        ok: true,
        result: { file_id, file_unique_id: file_id, file_path: `files/${file_id}` } as never,
      });
    });
    const send = (text: string) =>
      harness.bot.handleUpdate(
        textUpdate({ updateId: ++updateId, messageId: updateId, text, date: SENT }),
      );
    const sendPdf = (
      bytes: Uint8Array,
      document: { fileName?: string; mimeType?: string; fileSize?: number } = {},
    ) => {
      const fileId = `file-${++updateId}`;
      files.set(fileId, bytes);
      return harness.bot.handleUpdate({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(SENT.getTime() / 1000),
          chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
          from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: document.fileName ?? 'izvod.pdf',
            mime_type: document.mimeType ?? 'application/pdf',
            file_size: document.fileSize ?? bytes.length,
          },
        },
      });
    };
    const tap = (data: string) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId: 500 }));
    return { ...harness, send, sendPdf, tap };
  }

  const TWO_PAGE_PDF = statementPdf(TWO_PAGE_ROWS, { rowsPerPage: 6 });
  const PREVIEW = [
    '<b>Выписка за 01.09.2026–30.09.2026</b> → «Личные расходы»',
    'Найдено 6 покупок, новых: 6',
    'На сумму: 4 134.56 RSD, 15.00 USD, 0.30 EUR',
    '',
    '02.09 · 450.00 RSD · PRODAVNICA PRIMER BEOGRAD',
    '05.09 · 1 234.56 RSD · SUPERMARKET PRIMER NOVI SAD BULEVAR OSLOBOĐENJA 1',
    '07.09 · 15.00 USD · EXAMPLE.COM AMSTERDAM',
    '07.09 · 0.30 EUR · EXAMPLE.COM AMSTERDAM',
    '14.09 · 2 000.00 RSD · APOTEKA PRIMER',
    '20.09 · 450.00 RSD · KAFE PRIMER',
  ].join('\n');

  function storedRows(db: Db) {
    return db
      .prepare('SELECT amount_minor, currency, occurred_on FROM expenses ORDER BY rowid')
      .all();
  }

  it('previews a statement PDF with its card purchases and records nothing yet', async () => {
    const { sendPdf, calls, db } = statementBot();

    await sendPdf(TWO_PAGE_PDF);

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(calls.filter((call) => call.method !== 'getFile')).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: PREVIEW,
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Записать все (6)', callback_data: 'stm:all' }],
              [{ text: 'Отмена', callback_data: 'stm:x' }],
            ],
          },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('[Записать все] records the 6 card purchases dated by transaction, in their own currency', async () => {
    const { sendPdf, tap, calls, db } = statementBot();
    await sendPdf(TWO_PAGE_PDF);
    calls.length = 0;

    await tap('stm:all');

    expect(storedRows(db)).toEqual([
      { amount_minor: 45000, currency: 'RSD', occurred_on: '2026-09-02' },
      { amount_minor: 123456, currency: 'RSD', occurred_on: '2026-09-05' },
      { amount_minor: 1500, currency: 'USD', occurred_on: '2026-09-07' },
      { amount_minor: 30, currency: 'EUR', occurred_on: '2026-09-07' },
      { amount_minor: 200000, currency: 'RSD', occurred_on: '2026-09-14' },
      { amount_minor: 45000, currency: 'RSD', occurred_on: '2026-09-20' },
    ]);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-2', text: 'Выписка записана' },
      },
      {
        method: 'editMessageText',
        payload: {
          chat_id: ALLOWED_ID,
          message_id: 500,
          text: 'Записано в «Личные расходы»: 6 покупок на 4 134.56 RSD, 15.00 USD, 0.30 EUR.',
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('[Отмена] records nothing, and a later [Записать все] answers that time is up', async () => {
    const { sendPdf, tap, calls, db } = statementBot();
    await sendPdf(TWO_PAGE_PDF);
    calls.length = 0;

    await tap('stm:x');
    await tap('stm:all');

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls.filter((call) => call.method === 'editMessageText'))).toEqual([
      messages.statementCancelled,
      messages.flowExpired,
    ]);
  });

  it('records a typed expense while a preview is pending, and the buttons still work', async () => {
    const { sendPdf, send, tap, db } = statementBot();
    await sendPdf(TWO_PAGE_PDF);

    await send('450 кофе');
    await tap('stm:all');

    expect(expenseCount(db)).toEqual({ n: 7 });
  });

  it('answers a PDF that is not this statement with the help reply and records nothing', async () => {
    const { sendPdf, calls, db } = statementBot();

    await sendPdf(buildPdf([[{ y: 40, cells: [{ x: 20, text: 'Racun za struju' }] }]]));

    expect(expenseCount(db)).toEqual({ n: 0 });
    expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([
      messages.help,
    ]);
  });

  it('reads a document named .pdf without the PDF MIME type', async () => {
    const { sendPdf, calls } = statementBot();

    await sendPdf(TWO_PAGE_PDF, { mimeType: 'application/octet-stream', fileName: 'IZVOD.PDF' });

    expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([PREVIEW]);
  });

  it('records the rows once when the same file is sent and recorded twice', async () => {
    const { sendPdf, tap, calls, db } = statementBot();
    await sendPdf(TWO_PAGE_PDF);
    await tap('stm:all');
    calls.length = 0;

    await sendPdf(TWO_PAGE_PDF);
    await tap('stm:all');

    expect(expenseCount(db)).toEqual({ n: 6 });
    const preview = calls.find((call) => call.method === 'sendMessage');
    expect(preview?.payload).toMatchObject({
      text: [
        '<b>Выписка за 01.09.2026–30.09.2026</b> → «Личные расходы»',
        'Найдено 6 покупок, новых: 0',
        'Уже записано: 6',
        messages.statementNothingNew,
      ].join('\n'),
      reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'stm:x' }]] },
    });
  });

  it('skips a row already recorded by hand, and [Записать и уже записанные] records N+M', async () => {
    const { send, sendPdf, tap, calls, db } = statementBot();
    // KAFE PRIMER's 450.00 RSD of the 20th, typed a day later.
    await send('/start');
    await send('450 кофе 21.09');
    expect(expenseCount(db)).toEqual({ n: 1 });
    calls.length = 0;

    await sendPdf(TWO_PAGE_PDF);

    const preview = calls.find((call) => call.method === 'sendMessage');
    expect((preview?.payload as { text: string }).text.split('\n').slice(1, 3)).toEqual([
      'Найдено 6 покупок, новых: 5',
      'Уже записано: 1',
    ]);
    expect(preview?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Записать все (5)', callback_data: 'stm:all' }],
          [{ text: 'Записать и уже записанные (6)', callback_data: 'stm:dup' }],
          [{ text: 'Отмена', callback_data: 'stm:x' }],
        ],
      },
    });

    await tap('stm:dup');

    expect(expenseCount(db)).toEqual({ n: 1 + 6 });
    expect(calls.at(-1)?.payload).toMatchObject({
      text: 'Записано в «Личные расходы»: 6 покупок на 4 134.56 RSD, 15.00 USD, 0.30 EUR.',
    });
  });

  it('[Записать все] leaves the row already recorded by hand out', async () => {
    const { send, sendPdf, tap, db } = statementBot();
    await send('450 кофе 21.09');
    await sendPdf(TWO_PAGE_PDF);

    await tap('stm:all');

    expect(expenseCount(db)).toEqual({ n: 1 + 5 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE occurred_on = '2026-09-20'").get(),
    ).toEqual({ n: 0 });
  });

  describe('paging, limits and errors', () => {
    // 25 purchases of 1.00 to 25.00 RSD, one per day from 1 September.
    const ROWS_25 = Array.from({ length: 25 }, (_, index) =>
      cardRow(
        `${String(index + 1).padStart(2, '0')}.09.2026`,
        `${index + 1}.00`,
        `PRODAVNICA PRIMER ${index + 1}`,
      ),
    );
    const rowLines = (text: unknown) =>
      String(text)
        .split('\n')
        .filter((line) => / · PRODAVNICA PRIMER /.test(line));

    it('pages a 25-row preview 10, 10 and 5 rows', async () => {
      const { sendPdf, tap, calls } = statementBot();

      await sendPdf(statementPdf(ROWS_25));
      await tap('stm:p:2');
      await tap('stm:p:3');

      const shown = calls.filter(
        (call) => call.method === 'sendMessage' || call.method === 'editMessageText',
      );
      const payloads = shown.map(
        (call) =>
          call.payload as {
            text: string;
            reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
          },
      );
      expect(payloads.map((p) => rowLines(p.text).length)).toEqual([10, 10, 5]);
      expect(rowLines(payloads[0]?.text)[0]).toBe('01.09 · 1.00 RSD · PRODAVNICA PRIMER 1');
      expect(rowLines(payloads[2]?.text).at(-1)).toBe('25.09 · 25.00 RSD · PRODAVNICA PRIMER 25');
      expect(payloads.map((p) => p.reply_markup.inline_keyboard)).toEqual([
        [
          [{ text: 'Записать все (25)', callback_data: 'stm:all' }],
          [
            { text: '1/3', callback_data: 'stm:p:1' },
            { text: messages.pagerNext, callback_data: 'stm:p:2' },
          ],
          [{ text: 'Отмена', callback_data: 'stm:x' }],
        ],
        [
          [{ text: 'Записать все (25)', callback_data: 'stm:all' }],
          [
            { text: messages.pagerPrev, callback_data: 'stm:p:1' },
            { text: '2/3', callback_data: 'stm:p:2' },
            { text: messages.pagerNext, callback_data: 'stm:p:3' },
          ],
          [{ text: 'Отмена', callback_data: 'stm:x' }],
        ],
        [
          [{ text: 'Записать все (25)', callback_data: 'stm:all' }],
          [
            { text: messages.pagerPrev, callback_data: 'stm:p:2' },
            { text: '3/3', callback_data: 'stm:p:3' },
          ],
          [{ text: 'Отмена', callback_data: 'stm:x' }],
        ],
      ]);
    });

    it('lists a row already recorded after the new ones, marked «уже записано»', async () => {
      const { send, sendPdf, calls } = statementBot();
      await send('450 кофе 21.09');
      calls.length = 0;

      await sendPdf(TWO_PAGE_PDF);

      const text = String(sentTexts(calls.filter((call) => call.method === 'sendMessage'))[0]);
      expect(text.split('\n').at(-1)).toBe('20.09 · 450.00 RSD · KAFE PRIMER · уже записано');
    });

    it('does not download a document reported at 6 MB', async () => {
      const { sendPdf, calls } = statementBot();

      await sendPdf(TWO_PAGE_PDF, { fileSize: 6 * 1024 * 1024 });

      expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
      expect(fetched).toEqual([]);
      expect(sentTexts(calls)).toEqual([messages.statementTooLarge]);
    });

    it('answers a PDF with no text layer with statementNoText', async () => {
      const { sendPdf, calls, db } = statementBot();

      await sendPdf(buildPdf([[], []]));

      expect(expenseCount(db)).toEqual({ n: 0 });
      expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([
        messages.statementNoText,
      ]);
    });

    it('refuses a PDF over 30 pages with statementTooLong', async () => {
      const { sendPdf, calls } = statementBot();

      await sendPdf(statementPdf(ROWS_25.concat(ROWS_25.slice(0, 6)), { rowsPerPage: 1 }));

      expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([
        messages.statementTooLong,
      ]);
    });

    it('answers a file pdf.js cannot open with statementUnreadable, logging the error class', async () => {
      const { sendPdf, calls, logLines } = statementBot({ logLevel: 'info' });

      await sendPdf(new TextEncoder().encode('%PDF-1.4 broken'));

      expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([
        messages.statementUnreadable,
      ]);
      const reads = logLines.filter((line) => line.includes('statement read'));
      expect(reads).toHaveLength(1);
      expect(JSON.parse(String(reads[0]))).toMatchObject({
        level: 30,
        outcome: 'unreadable',
        error: expect.stringMatching(/^[A-Za-z]+$/) as unknown,
      });
      expect(String(reads[0])).not.toContain('broken');
    });

    it('answers an expired preview’s buttons with flowExpired and records nothing', async () => {
      const { sendPdf, tap, calls, db } = statementBot();
      await sendPdf(TWO_PAGE_PDF);
      db.prepare("UPDATE flow_sessions SET expires_at = '2026-10-02T08:00:00.000Z'").run();
      calls.length = 0;

      await tap('stm:p:2');
      await tap('stm:all');
      await tap('stm:dup');

      expect(expenseCount(db)).toEqual({ n: 0 });
      expect(sentTexts(calls.filter((call) => call.method === 'editMessageText'))).toEqual([
        messages.flowExpired,
        messages.flowExpired,
        messages.flowExpired,
      ]);
    });

    it('logs no merchant, amount or account number at any level above debug', async () => {
      const { send, sendPdf, tap, logLines } = statementBot({ logLevel: 'info' });
      await send('450 кофе 21.09');

      await sendPdf(TWO_PAGE_PDF);
      await tap('stm:p:1');
      await tap('stm:dup');
      await sendPdf(TWO_PAGE_PDF);

      expect(logLines.some((line) => line.includes('statement recorded'))).toBe(true);
      for (const line of logLines) {
        const content = logContent(line);
        expect(content).not.toMatch(
          /PRIMER|EXAMPLE|AMSTERDAM|OSLOBO|\b(?:450|45000|1,234\.56|123456|1500|15\.00|175685|2,000\.00|200000)\b|0{13}/,
        );
      }
    });
  });

  describe('sealed ledgers and the file on disk', () => {
    async function sealed() {
      const harness = statementBot();
      await harness.send('/start');
      const user = findUserByIdentity(harness.db, 'telegram', String(ALLOWED_ID));
      if (user === undefined) throw new Error('setup: no user');
      const keyDeps = { db: harness.db, logger: silentLogger(), keys: harness.keys };
      const ledger = await sealPersonalLedger(keyDeps, user, SENT);
      harness.calls.length = 0;
      return { ...harness, user, keyDeps, ledger };
    }

    it('answers a statement to a locked sealed ledger with the locked message and keeps nothing', async () => {
      const { sendPdf, calls, db } = await sealed();

      await sendPdf(TWO_PAGE_PDF);

      expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([
        messages.ledgerLocked,
      ]);
      expect(expenseCount(db)).toEqual({ n: 0 });
      expect(db.prepare('SELECT kind FROM flow_sessions').pluck().all()).not.toContain(
        'statementImport',
      );
    });

    it('after /unlock previews the same file and records sealed rows that open to its amounts', async () => {
      const { sendPdf, tap, calls, db, keys, user, keyDeps, ledger } = await sealed();
      await sendPdf(TWO_PAGE_PDF);
      await unlockPersonalLedger(keyDeps, user, SENT);
      calls.length = 0;

      await sendPdf(TWO_PAGE_PDF);
      await tap('stm:all');

      expect(sentTexts(calls.filter((call) => call.method === 'sendMessage'))).toEqual([PREVIEW]);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM expenses WHERE sealed IS NOT NULL AND amount_minor IS NULL',
          )
          .get(),
      ).toEqual({ n: 6 });
      const opened = openExpenses(
        { db, keys },
        ledger.id,
        listLedgerExpensesBetween(db, {
          ledgerId: ledger.id,
          memberId: user.id,
          from: '2026-09-01' as LocalDate,
          to: '2026-09-30' as LocalDate,
        }),
      );
      if (opened.kind !== 'open') throw new Error('expected the ledger open');
      expect(opened.expenses.map((e) => [e.occurredOn, e.amountMinor, e.currency])).toEqual([
        ['2026-09-02', 45000, 'RSD'],
        ['2026-09-05', 123456, 'RSD'],
        ['2026-09-07', 1500, 'USD'],
        ['2026-09-07', 30, 'EUR'],
        ['2026-09-14', 200000, 'RSD'],
        ['2026-09-20', 45000, 'RSD'],
      ]);
    });

    it('never writes the downloaded file under the data directory', async () => {
      // A bot on a database file in its own data directory, as in production.
      const dataDir = mkdtempSync(join(tmpdir(), 'peb-statement-'));
      try {
        const db = openDatabase(join(dataDir, 'bot.db'));
        runMigrations(db, SENT);
        quietFirstContact(db);
        let n = 0;
        const bot = createBot({
          db,
          logger: silentLogger(),
          newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
          now: () => SENT,
          defaultTimezone: 'Europe/Belgrade',
          defaultCurrency: 'RSD',
          keys: createLedgerKeyring(() => SENT),
          adminTelegramId: ALLOWED_ID,
          token: '123456:test-token',
          backupKeep: 14,
          botInfo: {
            id: 42,
            is_bot: true,
            first_name: 'Test Bot',
            username: 'test_bot',
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
            can_connect_to_business: false,
            has_main_web_app: false,
            has_topics_enabled: false,
            allows_users_to_create_topics: false,
            can_manage_bots: false,
            supports_join_request_queries: false,
          },
        });
        const sent: string[] = [];
        bot.api.config.use((_prev, method, payload) => {
          if (method === 'getFile') {
            const { file_id } = payload as { file_id: string };
            return Promise.resolve({
              ok: true,
              result: { file_id, file_unique_id: file_id, file_path: `files/${file_id}` } as never,
            });
          }
          if (method === 'sendMessage') sent.push((payload as { text: string }).text);
          return Promise.resolve({ ok: true, result: true as never });
        });
        files.set('izvod', TWO_PAGE_PDF);

        await bot.handleUpdate({
          update_id: 1,
          message: {
            message_id: 1,
            date: Math.floor(SENT.getTime() / 1000),
            chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
            from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
            document: {
              file_id: 'izvod',
              file_unique_id: 'izvod',
              file_name: 'izvod.pdf',
              mime_type: 'application/pdf',
              file_size: TWO_PAGE_PDF.length,
            },
          },
        });
        await bot.handleUpdate(callbackUpdate({ updateId: 2, data: 'stm:all' }));
        db.close();

        expect(sent).toEqual([PREVIEW]);
        expect(fetched).toHaveLength(1);
        const names = readdirSync(dataDir).sort();
        expect(names.every((name) => name.startsWith('bot.db'))).toBe(true);
        const header = Buffer.from('%PDF-');
        for (const name of names) {
          expect(readFileSync(join(dataDir, name)).includes(header)).toBe(false);
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  it('does not load pdfjs-dist with the bot wiring, only for a PDF', async () => {
    // A fresh module graph, with a probe that counts each load of the PDF engine.
    vi.resetModules();
    const loads = { count: 0 };
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
      loads.count++;
      return importOriginal();
    });
    try {
      const harness = await import('./testHarness.js');
      const { bot } = harness.createTestBot({ now: SENT });

      await bot.handleUpdate(harness.textUpdate({ updateId: 1, text: '/start' }));
      await bot.handleUpdate(harness.textUpdate({ updateId: 2, messageId: 2, text: '450 кофе' }));

      expect(loads.count).toBe(0);
      // The probe counts: reading a PDF loads it once.
      const { readPdfLines } = await import('../statements/pdf.js');
      await readPdfLines(TWO_PAGE_PDF);
      expect(loads.count).toBe(1);
    } finally {
      vi.doUnmock('pdfjs-dist/legacy/build/pdf.mjs');
    }
  });
});

describe('tags (Plan 0012)', () => {
  // The harness's messages are sent 23:50 local on 2026-09-29.
  const DAY = '2026-09-29' as LocalDate;

  function storeEurRate(db: Db) {
    const fetchedAt = new Date('2026-09-29T08:00:00Z');
    storeFxList(
      db,
      { listDate: DAY, listNumber: 185, rates: [{ currency: 'EUR', unit: 1, middleE4: 1171234 }] },
      fetchedAt,
    );
    setFxDay(db, DAY, DAY, fetchedAt);
  }

  function tagBot() {
    const harness = createTestBot();
    let updateId = 0;
    const say = (text: string, messageId: number, date?: Date) =>
      harness.bot.handleUpdate(
        textUpdate({
          updateId: ++updateId,
          messageId,
          text,
          ...(date === undefined ? {} : { date }),
        }),
      );
    const tap = (data: string, messageId = 50) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId }));
    return { ...harness, say, tap };
  }

  const lastText = (calls: readonly ApiCall[]) =>
    (calls.at(-1)?.payload as { text?: string } | undefined)?.text;
  const hashOf = (name: string) => tagHash(name as TagName);

  it('confirms 450 кофе #отпуск with the tag after the category', async () => {
    const { say, calls, db } = tagBot();

    await say('450 кофе #отпуск', 1);

    expect(lastText(calls)).toBe(
      'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны · #отпуск',
    );
    expect(db.prepare('SELECT description, tags FROM expenses').all()).toEqual([
      { description: 'кофе', tags: 'отпуск' },
    ]);
  });

  it('refuses six distinct tags and records nothing', async () => {
    const { say, calls, db } = tagBot();

    await say('450 кофе #a #b #c #d #e #f', 1);

    expect(lastText(calls)).toBe(messages.tooManyTags);
    expect(expenseCount(db)).toEqual({ n: 0 });
  });

  it('refuses 450 #отпуск as an expense with no description', async () => {
    const { say, calls, db } = tagBot();

    await say('450 #отпуск', 1);

    expect(lastText(calls)).toBe(messages.invalidAmount);
    expect(expenseCount(db)).toEqual({ n: 0 });
  });

  it('lists #отпуск at 1 914.04 RSD: 450 RSD plus 12.50 EUR at 117.1234', async () => {
    const { say, calls, db } = tagBot();
    storeEurRate(db);
    await say('450 кофе #отпуск', 1);
    await say('12,50 EUR такси #отпуск', 2);
    await say('300 хлеб', 3);

    await say('/tags', 4);

    expect(calls.at(-1)).toEqual({
      method: 'sendMessage',
      payload: {
        chat_id: ALLOWED_ID,
        text: '<b>Метки — «Личные расходы»</b>\n#отпуск — 1 914.04 RSD',
        reply_markup: {
          inline_keyboard: [[{ text: '#отпуск', callback_data: `tag:s:${hashOf('отпуск')}` }]],
        },
        ...htmlParseMode,
      },
    });
  });

  it('reports #отпуск: 1 914.04 RSD over 2 expenses, Транспорт before Кафе, then back', async () => {
    const { say, tap, calls, db } = tagBot();
    storeEurRate(db);
    await say('450 кофе #отпуск', 1);
    await say('12,50 EUR такси #отпуск', 2);
    await say('300 хлеб', 3);

    await tap(`tag:s:${hashOf('отпуск')}`);

    expect(calls.at(-1)).toEqual({
      method: 'editMessageText',
      payload: {
        chat_id: ALLOWED_ID,
        message_id: 50,
        text:
          '<b>#отпуск — «Личные расходы»</b>\n29.09 · 2 расхода\n\n' +
          '<b>≈ 1 914.04 RSD</b>\nТранспорт: 1 464.04 RSD\nКафе и рестораны: 450.00 RSD\n\n' +
          'Включая 12.50 EUR по курсу НБС на день траты.',
        reply_markup: {
          inline_keyboard: [[{ text: messages.backButton, callback_data: 'tag:l:1' }]],
        },
        ...htmlParseMode,
      },
    });
  });

  it('shows the range 28.09–30.09 for expenses on the 28th and the 30th', async () => {
    const { say, tap, calls } = tagBot();
    await say('450 кофе #отпуск 28.09', 1);
    await say('300 такси #отпуск', 2, new Date('2026-09-30T10:00:00Z'));

    await tap(`tag:s:${hashOf('отпуск')}`);

    expect(lastText(calls)).toContain('28.09–30.09 · 2 расхода');
  });

  it('answers tagGone and shows the list again once the tag is gone', async () => {
    const { say, tap, calls } = tagBot();
    await say('450 кофе #отпуск', 1);
    await say('300 такси #рим', 2);
    await tap(`exp:undo:00000000-0000-4000-8000-000000000004`);
    calls.length = 0;

    await tap(`tag:s:${hashOf('рим')}`);

    expect(calls[0]).toEqual({
      method: 'answerCallbackQuery',
      payload: { callback_query_id: expect.any(String) as string, text: messages.tagGone },
    });
    expect(lastText(calls)).toBe('<b>Метки — «Личные расходы»</b>\n#отпуск — 450.00 RSD');
  });

  describe('the sticky tag', () => {
    const offKeyboard = {
      inline_keyboard: [[{ text: messages.stickyTagOffButton, callback_data: 'tag:off' }]],
    };

    it('turns on with /tag отпуск and tags 300 такси #рим as #рим #отпуск', async () => {
      const { say, calls, db } = tagBot();

      await say('/tag Отпуск', 1);
      expect(calls.at(-1)?.payload).toMatchObject({
        text: messages.stickyTagOn({
          ledger: { kind: 'personal', name: 'Personal' },
          name: 'отпуск',
        }),
        reply_markup: offKeyboard,
      });

      await say('300 такси #рим', 2);
      expect(lastText(calls)).toBe(
        'Записано в «Личные расходы»: <b>300.00 RSD</b> — такси · Транспорт · #рим #отпуск',
      );
      await say('300 такси #отпуск', 3);
      expect(db.prepare('SELECT tags FROM expenses ORDER BY rowid').pluck().all()).toEqual([
        'рим отпуск',
        'отпуск',
      ]);
    });

    it('shows the current tag with /tag, or stickyTagNone, and the usage for a bad name', async () => {
      const { say, calls } = tagBot();

      await say('/tag', 1);
      expect(lastText(calls)).toBe(messages.stickyTagNone);
      await say('/tag два слова', 2);
      expect(lastText(calls)).toBe(messages.stickyTagUsage);
      await say('/tag отпуск', 3);
      await say('/tag', 4);
      expect(calls.at(-1)?.payload).toMatchObject({
        text: messages.stickyTagCurrent({
          ledger: { kind: 'personal', name: 'Personal' },
          name: 'отпуск',
        }),
        reply_markup: offKeyboard,
      });
    });

    it('[Снять метку] clears it, a second tap is harmless, and 300 такси has no tag', async () => {
      const { say, tap, calls, db } = tagBot();
      await say('/tag отпуск', 1);

      await tap('tag:off');
      await tap('tag:off');
      expect(
        calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload),
      ).toMatchObject([{ text: messages.stickyTagOff }, { text: messages.stickyTagOff }]);

      await say('300 такси', 2);
      expect(lastText(calls)).toBe(
        'Записано в «Личные расходы»: <b>300.00 RSD</b> — такси · Транспорт',
      );
      expect(db.prepare('SELECT tags FROM expenses').pluck().all()).toEqual([null]);
    });

    it('tags a receipt recorded while it is set', async () => {
      const sent = new Date('2026-10-01T08:00:00Z');
      const { bot, calls, db } = createTestBot({ now: sent });
      await bot.handleUpdate(
        textUpdate({ updateId: 1, messageId: 1, text: '/tag отпуск', date: sent }),
      );

      await bot.handleUpdate(
        textUpdate({ updateId: 2, messageId: 2, text: buildRsUrl(), date: sent }),
      );

      expect(lastText(calls)).toBe(
        'Записано в «Личные расходы»: <b>829.12 RSD</b> — Чек · Другое · #отпуск',
      );
      expect(db.prepare('SELECT tags FROM expenses').pluck().all()).toEqual(['отпуск']);
    });
  });

  it('edits #отпуск to #ремонт from the card, so /tags lists #ремонт alone', async () => {
    const { say, tap, calls } = tagBot();
    await say('450 кофе #отпуск', 1);
    const id = '00000000-0000-4000-8000-000000000003';

    await tap(`exp:ef:${id}:g`);
    expect(lastText(calls)).toBe(
      'Сейчас: #отпуск. Отправьте метки через пробел, например «#отпуск #рим», или «-», чтобы убрать все.',
    );
    await say('#ремонт', 2);
    expect(lastText(calls)).toBe(
      'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны · #ремонт',
    );

    await say('/tags', 3);
    expect(lastText(calls)).toBe('<b>Метки — «Личные расходы»</b>\n#ремонт — 450.00 RSD');
  });

  it('seals #лечение in a sealed ledger, answers locked, and lists it after /unlock', async () => {
    const { say, calls, db, keys } = tagBot();
    await say('/start', 1);
    const user = findUserByIdentity(db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('setup: no user');
    const keyDeps = { db, logger: silentLogger(), keys };
    const now = new Date('2026-09-29T22:10:00Z');
    const ledger = await sealPersonalLedger(keyDeps, user, now);

    await say('450 кофе #лечение', 2);

    const rows = db.prepare('SELECT * FROM expenses').all() as Record<string, unknown>[];
    expect(rows.map((row) => row.tags)).toEqual([null]);
    const needle = Buffer.from('лечение', 'utf8');
    for (const value of Object.values(rows[0] ?? {})) {
      if (Buffer.isBuffer(value)) expect(value.includes(needle)).toBe(false);
      else expect(String(value)).not.toContain('лечение');
    }

    keys.lock(ledger.id);
    await say('/tags', 3);
    expect(lastText(calls)).toBe(messages.ledgerLocked);

    await unlockPersonalLedger(keyDeps, user, now);
    await say('/tags', 4);
    expect(lastText(calls)).toBe('<b>Метки — «Личные расходы»</b>\n#лечение — 450.00 RSD');
  });

  it('keeps a 32-letter Cyrillic tag button at 14 bytes', () => {
    const data = tagShowData(hashOf('я'.repeat(32)));

    expect(Buffer.byteLength(data, 'utf8')).toBe(14);
    expect(assertCallbackData(data)).toBe(data);
  });

  it('drops a deleted expense from /tags, and answers tagsEmpty once none is left', async () => {
    const { say, tap, calls } = tagBot();
    await say('450 кофе #отпуск', 1);
    await say('300 такси #рим', 2);
    // The second expense's id: /start is not sent, so the ids run 1, 2 per expense.
    const second = '00000000-0000-4000-8000-000000000004';
    await tap(`exp:undo:${second}`);

    await say('/tags', 3);
    expect(lastText(calls)).toBe('<b>Метки — «Личные расходы»</b>\n#отпуск — 450.00 RSD');

    await tap(`exp:undo:00000000-0000-4000-8000-000000000003`);
    await say('/tags', 4);
    expect(lastText(calls)).toBe(messages.tagsEmpty);
  });

  it('pages nine tags eight to a page, most recently used first', async () => {
    const { say, tap, calls } = tagBot();
    for (let i = 1; i <= 9; i++) {
      await say(`100 кофе #t${i}`, i, new Date(Date.UTC(2026, 8, 29, 10, i)));
    }

    await say('/tags', 20);

    const first = calls.at(-1)?.payload as { text: string; reply_markup: unknown };
    expect(first.text).toBe(
      [
        '<b>Метки — «Личные расходы»</b>',
        ...[9, 8, 7, 6, 5, 4, 3, 2].map((i) => `#t${i} — 100.00 RSD`),
      ].join('\n'),
    );
    expect(first.reply_markup).toEqual({
      inline_keyboard: [
        ...[
          [9, 8],
          [7, 6],
          [5, 4],
          [3, 2],
        ].map((pair) =>
          pair.map((i) => ({ text: `#t${i}`, callback_data: `tag:s:${hashOf(`t${i}`)}` })),
        ),
        [
          { text: '1/2', callback_data: 'tag:l:1' },
          { text: messages.pagerNext, callback_data: 'tag:l:2' },
        ],
      ],
    });

    await tap('tag:l:2');

    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageText',
      payload: { text: '<b>Метки — «Личные расходы»</b>\n#t1 — 100.00 RSD' },
    });
  });
});

describe('[☰ Ещё] (Plan 0034)', () => {
  const NOW = new Date('2026-10-06T10:00:00Z');
  const label = messages.moreButtons;
  type Button = { text: string; callback_data: string };
  const more = (text: string, key: string): Button => ({ text, callback_data: `more:${key}` });
  const adm = (text: string, key: string): Button => ({ text, callback_data: `adm:${key}` });

  function moreKeyboard(opts: { lockRow?: Button[][]; admin?: boolean } = {}) {
    return {
      inline_keyboard: [
        [more(label.recurring, 'rec'), more(label.debts, 'debt')],
        [more(label.tags, 'tags'), more(label.tag, 'tag')],
        [more(label.export, 'exp'), more(label.changelog, 'chg')],
        [more(label.donate, 'don'), more(label.paysupport, 'pay')],
        [more(label.privacy, 'prv'), more(label.deleteAccount, 'del')],
        ...(opts.lockRow ?? []),
        ...(opts.admin === true
          ? [
              [adm(label.invite, 'inv'), adm(label.invites, 'invs')],
              [adm(label.stats, 'stats'), adm(label.block, 'blk')],
              [adm(label.unblock, 'unb'), adm(label.refund, 'ref')],
            ]
          : []),
      ],
    };
  }

  // A fresh invite code is random: the payloads compare with it masked.
  function apiCalls(calls: readonly ApiCall[]): unknown {
    return JSON.parse(
      JSON.stringify(calls.filter((c) => c.method !== 'answerCallbackQuery')).replace(
        /start=[A-Za-z0-9_-]{11}/g,
        'start=<code>',
      ),
    );
  }

  function moreBot() {
    const harness = createTestBot({ now: NOW, donateUrl: 'https://example.org/donate' });
    withMessageIds(harness.bot);
    let updateId = 0;
    const send = (text: string, fromId = ADMIN_ID) =>
      harness.bot.handleUpdate(
        textUpdate({ updateId: ++updateId, text, fromId, messageId: updateId }),
      );
    const tap = (data: string, fromId = ADMIN_ID, messageId = 2) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, fromId, messageId }));
    return { ...harness, send, tap };
  }

  const pendingFlow = (db: Db) => db.prepare('SELECT kind FROM flow_sessions').pluck().all();

  it("answers a user's ☰ Ещё with the more screen, and the admin's with the admin rows", async () => {
    const { send, calls } = moreBot();

    await send('☰ Ещё', SECOND_ALLOWED_ID);
    await send('☰ Ещё', ADMIN_ID);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: SECOND_ALLOWED_ID,
          text: messages.moreScreen,
          reply_markup: moreKeyboard(),
          ...htmlParseMode,
        },
      },
      {
        method: 'sendMessage',
        payload: {
          chat_id: ADMIN_ID,
          text: messages.moreScreen,
          reply_markup: moreKeyboard({ admin: true }),
          ...htmlParseMode,
        },
      },
    ]);
  });

  const ARG_COMMANDS = ['tag', 'paysupport', 'block', 'unblock', 'refund'];
  const direct = MORE_BUTTONS.filter((b) => !ARG_COMMANDS.includes(b.command));
  const withArg = MORE_BUTTONS.filter((b) => ARG_COMMANDS.includes(b.command));

  it.each(direct.map((b) => [b.data, b.command]))(
    'answers %s exactly as /%s does',
    async (data, command) => {
      const typed = moreBot();
      const tapped = moreBot();

      await typed.send(`/${command}`);
      await tapped.tap(data);

      expect(typed.calls.length).toBeGreaterThan(0);
      expect(apiCalls(tapped.calls)).toEqual(apiCalls(typed.calls));
      expect(tapped.calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(1);
    },
  );

  it.each(withArg.map((b) => [b.data, b.command]))(
    '%s asks for the argument, and the answer runs /%s with it',
    async (data, command) => {
      const typed = moreBot();
      const tapped = moreBot();

      await typed.send(`/${command} отпуск`);
      await tapped.tap(data);
      const prompt = tapped.calls.filter((c) => c.method === 'sendMessage');
      tapped.calls.length = 0;
      await tapped.send('отпуск');

      const key = command as keyof typeof messages.commandArgPrompt;
      expect(prompt).toEqual([
        {
          method: 'sendMessage',
          payload: {
            chat_id: ADMIN_ID,
            text: messages.commandArgPrompt[key],
            reply_markup: {
              inline_keyboard: [[{ text: messages.cancelButton, callback_data: 'flow:cancel' }]],
            },
            ...htmlParseMode,
          },
        },
      ]);
      // The prompt loses its [Отмена], then the command answers as typed.
      expect(tapped.calls[0]).toEqual({
        method: 'editMessageText',
        payload: {
          chat_id: ADMIN_ID,
          message_id: 101,
          text: messages.commandArgPrompt[key],
          reply_markup: { inline_keyboard: [] },
          ...htmlParseMode,
        },
      });
      expect(apiCalls(tapped.calls.slice(1))).toEqual(apiCalls(typed.calls));
      expect(pendingFlow(tapped.db)).toEqual([null]);
    },
  );

  it('[Заблокировать] then an id blocks that user exactly as /block <id> does', async () => {
    const typed = moreBot();
    const tapped = moreBot();
    await typed.send('/start', SECOND_ALLOWED_ID);
    await tapped.send('/start', SECOND_ALLOWED_ID);
    typed.calls.length = 0;
    tapped.calls.length = 0;
    const blocked = (db: Db) =>
      db
        .prepare(
          'SELECT blocked_at IS NOT NULL FROM users WHERE id IN (SELECT user_id FROM auth_identities WHERE external_id = ?)',
        )
        .pluck()
        .get(String(SECOND_ALLOWED_ID));

    await typed.send(`/block ${SECOND_ALLOWED_ID}`);
    await tapped.tap('adm:blk');
    await tapped.send(String(SECOND_ALLOWED_ID));

    expect(sentTexts(typed.calls)).toEqual([messages.blocked(SECOND_ALLOWED_ID)]);
    expect(sentTexts(tapped.calls.filter((c) => c.method === 'sendMessage'))).toEqual([
      messages.commandArgPrompt.block,
      messages.blocked(SECOND_ALLOWED_ID),
    ]);
    expect(blocked(typed.db)).toBe(1);
    expect(blocked(tapped.db)).toBe(1);
  });

  it("refuses a non-numeric answer with /block's own usage", async () => {
    const { send, tap, calls } = moreBot();

    await tap('adm:blk');
    await send('Петя');

    expect(sentTexts(calls.filter((c) => c.method === 'sendMessage')).at(-1)).toBe(
      messages.blockUsage,
    );
  });

  it('[Отмена] on the prompt ends the flow with nothing changed', async () => {
    const { send, tap, calls, db } = moreBot();
    await send('/start', SECOND_ALLOWED_ID);
    await tap('adm:blk');
    calls.length = 0;

    // The welcome and setup check took messages 101 and 102, the prompt 103.
    await tap('flow:cancel', ADMIN_ID, 103);
    await send(String(SECOND_ALLOWED_ID));

    expect(calls.filter((c) => c.method === 'editMessageText')).toEqual([
      {
        method: 'editMessageText',
        payload: {
          chat_id: ADMIN_ID,
          message_id: 103,
          text: messages.commandArgCancelled,
          reply_markup: { inline_keyboard: [] },
          ...htmlParseMode,
        },
      },
    ]);
    expect(
      db.prepare('SELECT COUNT(*) FROM users WHERE blocked_at IS NOT NULL').pluck().get(),
    ).toBe(0);
    expect(sentTexts(calls.filter((c) => c.method === 'sendMessage'))).not.toContain(
      messages.blocked(SECOND_ALLOWED_ID),
    );
  });

  it('runs the command once for a redelivered answer', async () => {
    const { bot, tap, calls } = moreBot();
    await tap('more:tag');
    calls.length = 0;
    const answer = textUpdate({ updateId: 50, text: 'отпуск', messageId: 50 });

    await bot.handleUpdate(answer);
    await bot.handleUpdate(answer);

    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('answers a forged adm:* tap from a non-admin as an unknown button and changes nothing', async () => {
    const { tap, calls, db } = moreBot();

    await tap('adm:blk', SECOND_ALLOWED_ID);
    await tap('adm:inv', SECOND_ALLOWED_ID);

    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-1' } },
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
    ]);
    expect(pendingFlow(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM invite_codes').pluck().get()).toBe(0);
  });

  it('offers [Открыть учёт] for a locked sealed ledger and [Закрыть учёт] for an unlocked one', async () => {
    const { send, calls, db, keys } = moreBot();
    await send('/start', SECOND_ALLOWED_ID);
    const user = findUserByIdentity(db, 'telegram', String(SECOND_ALLOWED_ID));
    if (user === undefined) throw new Error('setup: no user');
    const keyDeps = { db, logger: silentLogger(), keys };
    const ledger = await sealPersonalLedger(keyDeps, user, NOW);
    keys.lock(ledger.id);
    calls.length = 0;

    await send('☰ Ещё', SECOND_ALLOWED_ID);
    await unlockPersonalLedger(keyDeps, user, NOW);
    await send('☰ Ещё', SECOND_ALLOWED_ID);

    const markups = calls.map((c) => (c.payload as { reply_markup: unknown }).reply_markup);
    expect(markups).toEqual([
      moreKeyboard({ lockRow: [[more(label.unlock, 'unl')]] }),
      moreKeyboard({ lockRow: [[more(label.lock, 'lock')]] }),
    ]);
  });

  it('clears a pending flow before the command runs, as a typed command does', async () => {
    const { send, tap, db } = moreBot();
    await send('/settings');
    await tap('set:tzother', ADMIN_ID, 101);
    expect(pendingFlow(db)).toEqual(['setTimezone']);

    await tap('more:prv');

    expect(pendingFlow(db)).toEqual([null]);
  });

  describe('the guard: every private command has a button', () => {
    // Reached without a button of their own: /start opens the chat, /cancel ends a prompt that
    // carries [Отмена], /recover is offered by the unlock prompt, and /categories is a button on
    // the settings hub.
    const REACHED_ELSEWHERE = ['start', 'cancel', 'recover', 'categories'];

    function privateCommands(): string[] {
      const spy = vi.spyOn(Composer.prototype, 'command');
      try {
        const db = openDatabase(':memory:');
        runMigrations(db, NOW);
        privateComposer({
          db,
          logger: silentLogger(),
          newId: randomUUID,
          now: () => NOW,
          defaultTimezone: 'Europe/Belgrade',
          defaultCurrency: 'RSD',
          keys: createLedgerKeyring(() => NOW),
          adminTelegramId: ADMIN_ID,
          token: '123456:test-token',
          backupKeep: 14,
        });
        return spy.mock.calls.flatMap(([command]) =>
          Array.isArray(command) ? command : [command],
        );
      } finally {
        spy.mockRestore();
      }
    }

    function withoutButton(commands: readonly string[]): string[] {
      const covered = new Set([
        ...MENU_BAR_COMMANDS,
        ...MORE_BUTTONS.map((b) => b.command),
        ...REACHED_ELSEWHERE,
      ]);
      return commands.filter((c) => !covered.has(c));
    }

    it('finds the private and admin commands, and none without a button', () => {
      const commands = privateCommands();

      expect(commands).toEqual(
        expect.arrayContaining(['today', 'recurring', 'delete_account', 'tag', 'block', 'refund']),
      );
      expect(withoutButton(commands)).toEqual([]);
    });

    it('names a new command registered with no button', () => {
      expect(withoutButton([...privateCommands(), 'brand_new'])).toEqual(['brand_new']);
    });
  });
});

describe('notices shown once (Plan 0034, ADR-0037)', () => {
  const NOW = new Date('2026-10-06T10:00:00Z');
  const sticker = (updateId: number): Update => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_790_000_000,
      chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
      from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
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
  });

  function noticeBot() {
    const harness = createTestBot({ now: NOW });
    const lastMessageId = withMessageIds(harness.bot);
    let updateId = 0;
    const send = (text: string) =>
      harness.bot.handleUpdate(textUpdate({ updateId: ++updateId, text, messageId: updateId }));
    const tap = (data: string, messageId: number) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId }));
    const sendSticker = () => harness.bot.handleUpdate(sticker(++updateId));
    return { ...harness, send, tap, sendSticker, lastMessageId };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers the first sticker with the full help and the second with a line deleted after 60 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { sendSticker, calls, lastMessageId } = noticeBot();

    await sendSticker();
    await sendSticker();
    const transientId = lastMessageId();

    expect(sentTexts(calls)).toEqual([messages.help, messages.notUnderstood]);
    expect(messages.notUnderstood).toBe('Не понял. Как записать трату — в «❓ Помощь».');
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([
      { method: 'deleteMessage', payload: { chat_id: ALLOWED_ID, message_id: transientId } },
    ]);
  });

  it('still answers /help and ❓ Помощь with the full help after that', async () => {
    const { send, sendSticker, calls } = noticeBot();
    await sendSticker();
    await sendSticker();
    calls.length = 0;

    await send('/help');
    await send('❓ Помощь');

    expect(sentTexts(calls)).toEqual([messages.help, messages.help]);
  });

  it('answers an unknown command and a non-expense text with the line once the help was seen', async () => {
    const { send, calls } = noticeBot();

    await send('/foo');
    await send('/bar');
    await send('привет');

    expect(sentTexts(calls)).toEqual([
      messages.help,
      messages.notUnderstood,
      messages.notUnderstood,
    ]);
  });

  it('gives two concurrent first stickers one full help', async () => {
    const { bot, calls } = noticeBot();

    await Promise.all([bot.handleUpdate(sticker(1)), bot.handleUpdate(sticker(2))]);

    expect(sentTexts(calls).sort()).toEqual([messages.help, messages.notUnderstood].sort());
  });

  async function sealedNoticeBot() {
    const harness = noticeBot();
    await harness.send('/start');
    const user = findUserByIdentity(harness.db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('setup: no user');
    await sealPersonalLedger(
      { db: harness.db, logger: silentLogger(), keys: harness.keys },
      user,
      NOW,
    );
    harness.calls.length = 0;
    return harness;
  }

  it('warns about the plaintext copy on the first /export of a sealed ledger only', async () => {
    const { send, calls, db, keys } = await sealedNoticeBot();
    const user = findUserByIdentity(db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('setup: no user');
    // A sealed ledger exports only while unlocked.
    await unlockPersonalLedger({ db, logger: silentLogger(), keys }, user, NOW);

    await send('/export');
    await send('/export');

    expect(sentTexts(calls)).toEqual([
      messages.exportRangePrompt(true),
      messages.exportRangePrompt(false),
    ]);
    expect(messages.exportRangePrompt(true)).not.toBe(messages.exportRangePrompt(false));
  });

  it('says the reminder text is plaintext on the first reminder prompt of a sealed ledger only', async () => {
    const { send, tap, calls, lastMessageId } = await sealedNoticeBot();

    await send('/recurring');
    await tap('rec:rem', lastMessageId());
    await send('/recurring');
    await tap('rec:rem', lastMessageId());

    const prompts = calls
      .filter((c) => c.method === 'editMessageText')
      .map((c) => (c.payload as { text: string }).text);
    expect(prompts).toEqual([messages.reminderTextPromptSealed, messages.reminderTextPrompt]);
  });

  it('/delete_account leaves no notice row for the user', async () => {
    const { send, tap, sendSticker, db } = noticeBot();
    await sendSticker();
    await send('/export');
    expect(db.prepare('SELECT COUNT(*) FROM user_notices').pluck().get()).toBe(1);

    await send('/delete_account');
    await tap('acct:del', 2);

    expect(db.prepare('SELECT COUNT(*) FROM user_notices').pluck().get()).toBe(0);
  });
});

describe('onboarding (Plan 0015)', () => {
  // 14:05 on 1 October in Belgrade: CEST is UTC+2 until 2026-10-25.
  const NOW = new Date('2026-10-01T12:05:00Z');
  const CHECK = messages.setupCheck({
    timezone: 'Europe/Belgrade',
    localTime: '14:05',
    currency: 'RSD',
  });

  function onboardingBot(opts: { onboarding?: boolean; tips?: boolean } = {}) {
    const harness = createTestBot({
      now: NOW,
      onboarding: opts.onboarding ?? true,
      tips: opts.tips ?? true,
    });
    const lastMessageId = withMessageIds(harness.bot);
    let updateId = 0;
    const send = (text: string, fromId = ALLOWED_ID) =>
      harness.bot.handleUpdate(
        textUpdate({ updateId: ++updateId, text, fromId, messageId: updateId, date: NOW }),
      );
    const tap = (data: string, messageId: number) =>
      harness.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId }));
    const userId = (telegramId = ALLOWED_ID): UserId => {
      const user = findUserByIdentity(harness.db, 'telegram', String(telegramId));
      if (user === undefined) throw new Error('setup: no user');
      return user.id;
    };
    const onboardedAt = (telegramId = ALLOWED_ID) =>
      harness.db
        .prepare('SELECT onboarded_at FROM users WHERE id = ?')
        .pluck()
        .get(userId(telegramId));
    return { ...harness, send, tap, lastMessageId, userId, onboardedAt };
  }

  it("answers a new user's /start with the welcome and the setup check, then marks them onboarded", async () => {
    const { send, calls, onboardedAt } = onboardingBot();

    await send('/start');

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: WELCOME, ...withMenu } },
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Проверьте настройки:\nЧасовой пояс: Белград, у вас сейчас 14:05?\nВалюта по умолчанию: RSD',
          reply_markup: setupKeyboard,
          ...htmlParseMode,
        },
      },
    ]);
    expect(onboardedAt()).toBe(NOW.toISOString());
  });

  it('[Да, всё верно] edits the check to the confirmation, and a second tap raises no error', async () => {
    const { send, tap, calls, lastMessageId } = onboardingBot();
    await send('/start');
    const check = lastMessageId();
    calls.length = 0;

    await tap('onb:ok', check);
    await tap('onb:ok', check);

    const confirmed = {
      method: 'editMessageText',
      payload: {
        chat_id: ALLOWED_ID,
        message_id: check,
        text: 'Настройки сохранены: Белград, RSD. Изменить их можно в /settings.',
        ...htmlParseMode,
      },
    };
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
      confirmed,
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-3' } },
      confirmed,
    ]);
  });

  it('[Изменить] turns the check into the settings hub, where a picked timezone is stored', async () => {
    const { send, tap, calls, db, lastMessageId, userId } = onboardingBot();
    await send('/start');
    const check = lastMessageId();
    calls.length = 0;

    await tap('onb:edit', check);
    await tap('set:tz', check);
    await tap('set:tz:moscow', check);

    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(edits[0]?.payload).toMatchObject({
      chat_id: ALLOWED_ID,
      message_id: check,
      text: messages.settingsScreen({
        timezone: 'Europe/Belgrade',
        ledger: { kind: 'personal', name: 'Личные расходы', defaultCurrency: 'RSD' },
      }),
    });
    expect(edits).toHaveLength(3);
    expect(db.prepare('SELECT timezone FROM users WHERE id = ?').pluck().get(userId())).toBe(
      'Europe/Moscow',
    );
  });

  it('sends the welcome and the check for a new user whose first /start is an unresolved deep link', async () => {
    const { send, calls, onboardedAt } = onboardingBot();

    await send('/start e_00000000-0000-4000-8000-000000000999');

    expect(sentTexts(calls)).toEqual([WELCOME, CHECK]);
    expect(onboardedAt()).toBe(NOW.toISOString());
  });

  it("replays for an onboarded user: their tips start over and switch on, notices and others' tips stay", async () => {
    const { send, calls, db, userId, onboardedAt } = onboardingBot({ onboarding: false });
    await send('/help');
    await send('/help', SECOND_ALLOWED_ID);
    const before = onboardedAt();
    const insertTip = db.prepare("INSERT INTO user_tips VALUES (?, 'tipOther', ?)");
    insertTip.run(userId(), NOW.toISOString());
    insertTip.run(userId(SECOND_ALLOWED_ID), NOW.toISOString());
    db.prepare("INSERT INTO user_notices VALUES (?, 'stray_help', ?)").run(
      userId(),
      NOW.toISOString(),
    );
    db.prepare('UPDATE users SET tips_off = 1 WHERE id = ?').run(userId());
    calls.length = 0;

    await send('/start');

    expect(sentTexts(calls)).toEqual([WELCOME, CHECK]);
    expect(onboardedAt()).toBe(before);
    expect(db.prepare('SELECT user_id FROM user_tips').pluck().all()).toEqual([
      userId(SECOND_ALLOWED_ID),
    ]);
    expect(db.prepare('SELECT tips_off FROM users WHERE id = ?').pluck().get(userId())).toBe(0);
    expect(db.prepare('SELECT user_id, notice FROM user_notices').all()).toEqual([
      { user_id: userId(), notice: 'stray_help' },
    ]);
  });

  it('/delete_account leaves no tip row for the user', async () => {
    const { send, tap, db, userId } = onboardingBot({ onboarding: false });
    await send('/help');
    db.prepare("INSERT INTO user_tips VALUES (?, 'tipOther', ?)").run(userId(), NOW.toISOString());

    await send('/delete_account');
    await tap('acct:del', 2);

    expect(db.prepare('SELECT COUNT(*) FROM user_tips').pluck().get()).toBe(0);
  });

  describe('a first message that is not /start', () => {
    const CARD = 'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны';
    const CHECK_AFTER_EXPENSE = messages.setupCheck({
      timezone: 'Europe/Belgrade',
      localTime: '14:05',
      currency: 'RSD',
      afterExpense: true,
    });
    const sticker = (updateId: number): Update => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(NOW.getTime() / 1000),
        chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
        from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
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
    });

    it('records 450 кофе, confirms it, then sends the welcome and the check naming the currency', async () => {
      const { send, calls, db, onboardedAt } = onboardingBot();

      await send('450 кофе');

      expect(db.prepare('SELECT amount_minor, currency FROM expenses').all()).toEqual([
        { amount_minor: 45000, currency: 'RSD' },
      ]);
      expect(sentTexts(calls)).toEqual([CARD, WELCOME, CHECK_AFTER_EXPENSE]);
      expect(CHECK_AFTER_EXPENSE).toBe(
        'Трату выше я записал в RSD. Если валюта другая, нажмите под ней [Изменить] → [Сумма] и отправьте сумму с валютой, например «450 RUB».' +
          '\n\nПроверьте настройки:\nЧасовой пояс: Белград, у вас сейчас 14:05?\nВалюта по умолчанию: RSD',
      );
      expect(calls[1]?.payload).toMatchObject({ reply_markup: menuKeyboard });
      expect(calls[2]?.payload).toMatchObject({ reply_markup: setupKeyboard });
      expect(onboardedAt()).toBe(NOW.toISOString());
    });

    it('leaves the currency line out of the check when the first expense is in another currency', async () => {
      const { send, calls, db } = onboardingBot();

      await send('12,50 EUR такси');

      expect(db.prepare('SELECT amount_minor, currency FROM expenses').all()).toEqual([
        { amount_minor: 1250, currency: 'EUR' },
      ]);
      expect(sentTexts(calls)).toEqual([
        'Записано в «Личные расходы»: <b>12.50 EUR</b> — такси · Транспорт',
        WELCOME,
        CHECK,
      ]);
    });

    // With tips on, the second message would also bring the first tip (Phase 3).
    it('answers the second message with its confirmation only', async () => {
      const { send, calls } = onboardingBot({ tips: false });
      await send('450 кофе');
      calls.length = 0;

      await send('300 такси');

      expect(sentTexts(calls)).toEqual([
        'Записано в «Личные расходы»: <b>300.00 RSD</b> — такси · Транспорт',
      ]);
    });

    it('records one expense and sends the pair once for a redelivered first update', async () => {
      const { bot, calls, db } = onboardingBot({ tips: false });
      const update = textUpdate({ updateId: 1, text: '450 кофе', messageId: 1, date: NOW });

      await bot.handleUpdate(update);
      await bot.handleUpdate(update);

      expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
      // The redelivery gets the card again, and nothing after it.
      expect(sentTexts(calls)).toEqual([CARD, WELCOME, CHECK_AFTER_EXPENSE, CARD]);
    });

    it('answers a first /today with the today screen, then the pair without the expense line', async () => {
      const { send, calls } = onboardingBot();

      await send('/today');

      const texts = sentTexts(calls);
      expect(texts).toHaveLength(3);
      expect(texts.slice(1)).toEqual([WELCOME, CHECK]);
    });

    it('answers a first sticker with the pair alone, and the second with the short line', async () => {
      const { bot, calls, db, userId } = onboardingBot();

      await bot.handleUpdate(sticker(1));

      expect(sentTexts(calls)).toEqual([WELCOME, CHECK]);
      expect(
        db.prepare('SELECT notice FROM user_notices WHERE user_id = ?').pluck().all(userId()),
      ).toEqual(['stray_help']);
      calls.length = 0;

      await bot.handleUpdate(sticker(2));

      expect(sentTexts(calls)).toEqual([messages.notUnderstood]);
    });

    it('onboards no one on a callback query or a group message', async () => {
      const { bot, calls, db } = onboardingBot();

      await bot.handleUpdate(callbackUpdate({ updateId: 1, data: 'onb:ok', messageId: 5 }));
      await bot.handleUpdate(
        groupTextUpdate({ updateId: 2, text: '450 кофе', fromId: SECOND_ALLOWED_ID }),
      );

      expect(sentTexts(calls)).not.toContain(WELCOME);
      expect(
        db.prepare('SELECT COUNT(*) FROM users WHERE onboarded_at IS NOT NULL').pluck().get(),
      ).toBe(0);
    });
  });

  describe('tips (ADR-0028)', () => {
    const tipsOffKeyboard = {
      inline_keyboard: [[{ text: 'Отключить подсказки', callback_data: 'tip:off' }]],
    };
    const FIRST_EXPENSE_TIP =
      '💡 Категорию я подбираю сам и запоминаю ваши исправления. Под подтверждением: [Категория], [Изменить] и [Удалить].';

    it('sends the first-expense tip after the card, as its own message with the off button', async () => {
      const { send, calls } = onboardingBot({ onboarding: false });

      await send('450 кофе');

      expect(sentTexts(calls)).toEqual([
        'Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе · Кафе и рестораны',
        FIRST_EXPENSE_TIP,
      ]);
      expect(calls[1]?.payload).toMatchObject({ reply_markup: tipsOffKeyboard });
    });

    it('sends the past-date tip after the /today screen', async () => {
      const { send, calls } = onboardingBot({ onboarding: false });

      await send('/today');

      expect(sentTexts(calls).at(-1)).toBe(
        '💡 Забыли записать вчера? Добавьте дату последним словом: «450 такси вчера» или «450 такси 25.09».',
      );
    });

    it('sends one tip at most for a redelivered 450 кофе', async () => {
      const { bot, calls } = onboardingBot({ onboarding: false });
      const update = textUpdate({ updateId: 1, text: '450 кофе', messageId: 1, date: NOW });

      await bot.handleUpdate(update);
      await bot.handleUpdate(update);

      expect(sentTexts(calls).filter((text) => String(text).startsWith('💡'))).toEqual([
        FIRST_EXPENSE_TIP,
      ]);
    });

    it('[Отключить подсказки] switches tips off, says how to switch back, and drops its button', async () => {
      const { send, tap, calls, db, userId } = onboardingBot({ onboarding: false });
      await send('450 кофе');
      calls.length = 0;

      await tap('tip:off', 7);

      expect(calls).toEqual([
        {
          method: 'answerCallbackQuery',
          payload: {
            callback_query_id: 'cb-2',
            text: 'Подсказки отключены. Включить: /settings',
          },
        },
        {
          method: 'editMessageReplyMarkup',
          payload: { chat_id: ALLOWED_ID, message_id: 7, reply_markup: { inline_keyboard: [] } },
        },
      ]);
      expect(db.prepare('SELECT tips_off FROM users WHERE id = ?').pluck().get(userId())).toBe(1);
    });

    it('sends no tip on any trigger with tips off; [Подсказки: выкл] in the hub turns them back on', async () => {
      const { send, tap, calls, db, userId, lastMessageId } = onboardingBot({ onboarding: false });
      await send('/help');
      db.prepare('UPDATE users SET tips_off = 1 WHERE id = ?').run(userId());
      calls.length = 0;

      await send('450 кофе');
      await send('/today');
      await send('/settings');

      expect(sentTexts(calls).filter((text) => String(text).startsWith('💡'))).toEqual([]);
      const hub = calls.at(-1)?.payload as { reply_markup: { inline_keyboard: unknown[][] } };
      expect(hub.reply_markup.inline_keyboard.at(-1)).toEqual([
        { text: 'Подсказки: выкл', callback_data: 'set:tips' },
      ]);
      calls.length = 0;

      await tap('set:tips', lastMessageId());

      expect(db.prepare('SELECT tips_off FROM users WHERE id = ?').pluck().get(userId())).toBe(0);
      const edit = calls.find((c) => c.method === 'editMessageText')?.payload as {
        reply_markup: { inline_keyboard: unknown[][] };
      };
      expect(edit.reply_markup.inline_keyboard.at(-1)).toEqual([
        { text: 'Подсказки: вкл', callback_data: 'set:tips' },
      ]);
    });

    it('sends no tip for an expense recorded in a group', async () => {
      const { bot, calls, db } = onboardingBot({ onboarding: false });
      await bot.handleUpdate(
        myChatMemberUpdate({
          updateId: 1,
          fromId: ALLOWED_ID,
          oldStatus: 'left',
          newStatus: 'member',
        }),
      );
      calls.length = 0;

      await bot.handleUpdate(
        groupTextUpdate({ updateId: 2, text: '450 xyzzy', messageId: 3, date: NOW }),
      );

      expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
      expect(sentTexts(calls).filter((text) => String(text).startsWith('💡'))).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) FROM user_tips').pluck().get()).toBe(0);
    });
  });

  describe('the feature tips', () => {
    const tipsSent = (calls: readonly ApiCall[]) =>
      sentTexts(calls).filter((text) => String(text).startsWith('💡'));
    const BUDGET_TIP = String(messages.tips.tipBudget());
    const ENCRYPT_TIP = String(messages.tips.tipEncrypt());

    it('offers tipBudget on /month only to a ledger without a budget limit', async () => {
      const limited = onboardingBot({ onboarding: false });
      await limited.send('/help');
      const ledgerId = limited.db
        .prepare('SELECT active_ledger_id FROM users')
        .pluck()
        .get() as LedgerId;
      setBudgetLimit(limited.db, ledgerId, { limitMinor: 100_000, currency: 'RSD' }, NOW);
      await limited.send('/month');
      expect(tipsSent(limited.calls)).toEqual([]);

      const open = onboardingBot({ onboarding: false });
      await open.send('/month');
      expect(tipsSent(open.calls)).toEqual([BUDGET_TIP]);
    });

    it('offers tipEncrypt in the hub of an unsealed personal ledger, never a sealed or shared one', async () => {
      const plain = onboardingBot({ onboarding: false });
      await plain.send('/settings');
      expect(tipsSent(plain.calls)).toEqual([ENCRYPT_TIP]);

      const sealed = onboardingBot({ onboarding: false });
      await sealed.send('/help');
      const user = findUserByIdentity(sealed.db, 'telegram', String(ALLOWED_ID));
      if (user === undefined) throw new Error('setup: no user');
      await sealPersonalLedger(
        { db: sealed.db, logger: silentLogger(), keys: sealed.keys },
        user,
        NOW,
      );
      await sealed.send('/settings');
      expect(sentTexts(sealed.calls).at(-1)).toMatch(/^<b>Настройки<\/b>/);
      expect(tipsSent(sealed.calls)).toEqual([]);

      const shared = onboardingBot({ onboarding: false });
      await shared.bot.handleUpdate(
        myChatMemberUpdate({
          updateId: 90,
          fromId: ALLOWED_ID,
          oldStatus: 'left',
          newStatus: 'member',
        }),
      );
      const groupLedger = shared.db
        .prepare('SELECT ledger_id FROM ledger_chats')
        .pluck()
        .get() as string;
      shared.db.prepare('UPDATE users SET active_ledger_id = ?').run(groupLedger);
      await shared.send('/settings');
      expect(sentTexts(shared.calls).at(-1)).toContain(
        'Валюта по умолчанию для новых трат в «Семья»',
      );
      expect(tipsSent(shared.calls)).toEqual([]);
    });

    it('offers tipReceipt, not tipFirstExpense, for a recorded receipt', async () => {
      const { send, calls, db, userId } = onboardingBot({ onboarding: false });
      await send('/help');
      // The receipt lands in «Другое» until its store is fetched; that tip was seen long ago.
      db.prepare("INSERT INTO user_tips VALUES (?, 'tipOther', '2026-09-01T10:00:00.000Z')").run(
        userId(),
      );
      calls.length = 0;

      await send(buildRsUrl());

      expect(tipsSent(calls)).toEqual([
        '💡 Магазины я запоминаю: следующий чек из этого магазина получит ту же категорию.',
      ]);
    });

    it('names /month and /settings in the welcome of a newly bound group', async () => {
      const { bot, calls } = onboardingBot({ onboarding: false });

      await bot.handleUpdate(
        myChatMemberUpdate({
          updateId: 1,
          fromId: ALLOWED_ID,
          oldStatus: 'left',
          newStatus: 'member',
        }),
      );

      const welcome = String(
        sentTexts(calls).find((text) => String(text).startsWith('Здравствуйте')),
      );
      expect(welcome).toContain(
        'Итоги: /month. Часовой пояс и валюту группы меняет тот, кто меня добавил: /settings.',
      );
    });

    it('has a message for every registry key and a registry key for every tip message', () => {
      expect(Object.keys(messages.tips).sort()).toEqual([...TIP_KEYS].sort());
    });
  });

  it('keeps onb:ok at 6 bytes and onb:edit at 8, inside the callback limit', () => {
    expect(assertCallbackData(ONBOARDING_OK)).toBe('onb:ok');
    expect(assertCallbackData(ONBOARDING_EDIT)).toBe('onb:edit');
    expect(Buffer.byteLength(ONBOARDING_OK, 'utf8')).toBe(6);
    expect(Buffer.byteLength(ONBOARDING_EDIT, 'utf8')).toBe(8);
  });
});
