import { InlineKeyboard, InputFile, InputMediaBuilder, type Composer, type Context } from 'grammy';
import { writeCsv } from '../../domain/export/csv.js';
import { writeXlsx } from '../../domain/export/xlsx.js';
import {
  expensesTable,
  isExportRange,
  itemsTable,
  type ExportRange,
} from '../../domain/export/rows.js';
import {
  activeExportState,
  exportActiveLedger,
  type LedgerExport,
} from '../../services/exportLedger.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { seenNotice } from '../../services/notices.js';
import type { HandlerDeps } from '../bot.js';
import type { User } from '../../db/users.js';
import {
  EXPORT_BACK,
  EXPORT_FORMAT,
  EXPORT_RANGE,
  MENU_OPEN,
  exportBackData,
  exportFormatData,
  exportRangeData,
  type ExportFormat,
} from '../callbackData.js';
import { createTapGuard } from '../callbacks.js';
import { withMenuBack, type MenuOpened } from '../keyboards.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import type { ScreenView } from '../screens.js';
import { ensureUser } from './start.js';

// /export (ADR-0026): a range step and a format step edited in place, then the file sent as a
// document in the same update. Nothing is written, so the picker needs no anchor: a tap reads
// the active ledger here, the chat's binding in a group. A sealed ledger exports only while
// unlocked (ADR-0020). The log carries the range, format, row count and byte size, never a cell.

// Telegram takes bot uploads up to 50 MB; past this the export fails loudly instead.
const MAX_FILE_BYTES = 45 * 1024 * 1024;

// `fromMenu`: the picker was opened from the hub, so every step carries the hub mark and the
// range step ends in [« Назад] to the hub.
function rangeKeyboard(fromMenu: boolean): InlineKeyboard {
  const button = (range: ExportRange) =>
    InlineKeyboard.text(messages.exportRangeButtons[range], exportRangeData(range, fromMenu));
  return InlineKeyboard.from([
    [button('tm'), button('pm')],
    [button('ty'), button('all')],
    ...(fromMenu ? [[InlineKeyboard.text(messages.backButton, MENU_OPEN)]] : []),
  ]);
}

function formatKeyboard(range: ExportRange, fromMenu: boolean): InlineKeyboard {
  return InlineKeyboard.from([
    [
      InlineKeyboard.text(messages.exportCsvButton, exportFormatData(range, 'csv', fromMenu)),
      InlineKeyboard.text(messages.exportXlsxButton, exportFormatData(range, 'xlsx', fromMenu)),
    ],
    [InlineKeyboard.text(messages.exportBackButton, exportBackData(fromMenu))],
  ]);
}

export interface ExportFile {
  readonly filename: string;
  readonly bytes: Buffer;
}

// The files of an export in one format: the expenses, plus the receipt items when any exported
// expense has them, as a second CSV or a second sheet. The author column exists only for a
// shared ledger.
export function exportFiles(data: LedgerExport, format: ExportFormat): ExportFile[] {
  const tables = [
    expensesTable(
      messages.exportExpensesSheet,
      messages.exportColumns(data.ledger.defaultCurrency),
      data.expenses,
      data.ledger.kind === 'shared',
    ),
    ...(data.items.length === 0
      ? []
      : [itemsTable(messages.exportItemsSheet, messages.exportItemColumns, data.items)]),
  ];
  if (format === 'xlsx') {
    return [
      { filename: `${messages.exportExpensesStem}-${data.key}.xlsx`, bytes: writeXlsx(tables) },
    ];
  }
  const stems = [messages.exportExpensesStem, messages.exportItemsStem];
  return tables.map((table, i) => ({
    filename: `${stems[i] ?? messages.exportExpensesStem}-${data.key}.csv`,
    bytes: writeCsv(table),
  }));
}

// Sends the export's files to the chat of the tapped picker and closes the picker. An empty
// range sends nothing.
export async function sendExport(
  ctx: Context,
  deps: Pick<HandlerDeps, 'logger'>,
  data: LedgerExport,
  range: ExportRange,
  format: ExportFormat,
): Promise<void> {
  if (data.expenses.length === 0) {
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.exportEmpty);
    return;
  }
  const files = exportFiles(data, format);
  const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (files.some((file) => file.bytes.length > MAX_FILE_BYTES)) {
    throw new Error(`export file over ${MAX_FILE_BYTES} bytes`);
  }
  await ctx.answerCallbackQuery();
  const inputs = files.map((file) => new InputFile(file.bytes, file.filename));
  const [single] = inputs;
  if (inputs.length === 1 && single !== undefined) {
    await ctx.replyWithDocument(single);
  } else {
    // One album, so the two files stay together in the chat.
    await ctx.replyWithMediaGroup(inputs.map((input) => InputMediaBuilder.document(input)));
  }
  deps.logger.info(
    { ledgerId: data.ledger.id, range, format, rows: data.expenses.length, bytes },
    'export sent',
  );
  await editHtml(ctx, messages.exportDone(data.expenses.length, data.key));
}

// The range step's view; a sealed ledger's says the file is a copy outside the encryption.
export function rangeStep(sealed: boolean, fromMenu = false): ScreenView {
  return { text: messages.exportRangePrompt(sealed), markup: rangeKeyboard(fromMenu) };
}

// [← Назад] and a range tap, which edit the picker in place; shared with the group picker.
export async function showRangeStep(
  ctx: Context,
  sealed: boolean,
  fromMenu = false,
): Promise<void> {
  const step = rangeStep(sealed, fromMenu);
  await ctx.answerCallbackQuery();
  await editHtml(ctx, step.text, { reply_markup: step.markup });
}

export async function showFormatStep(ctx: Context, range: string, fromMenu = false): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!isExportRange(range)) return;
  await editHtml(ctx, messages.exportFormatPrompt, {
    reply_markup: formatKeyboard(range, fromMenu),
  });
}

// The /export view for the active ledger: the range step, or the locked message. The sealed
// ledger's plaintext-copy warning is shown once (ADR-0037).
function pickerView(deps: HandlerDeps, user: User, fromMenu: boolean): ScreenView {
  const now = deps.now();
  const state = activeExportState(deps, user);
  if (isLocked(state)) {
    return withMenuBack({ text: messages.ledgerLocked, markup: new InlineKeyboard() }, fromMenu);
  }
  return rangeStep(state.sealed && seenNotice(deps, user, 'export_plaintext', now), fromMenu);
}

// The hub's [Экспорт]: the range step, as /export shows it, with the hub mark in its data.
export function exportFromMenu(deps: HandlerDeps, user: User): MenuOpened {
  return { view: pickerView(deps, user, true) };
}

// /export: the range step for the active ledger.
export async function sendExportPicker(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const view = pickerView(deps, user, false);
  // The locked message carries no keyboard.
  const empty = view.markup.inline_keyboard.length === 0;
  await replyHtml(ctx, view.text, empty ? {} : { reply_markup: view.markup });
}

export function registerExport(bot: Composer<Context>, deps: HandlerDeps): void {
  const guard = createTapGuard();

  bot.command('export', (ctx) => sendExportPicker(ctx, deps));

  bot.callbackQuery(EXPORT_RANGE, (ctx) =>
    showFormatStep(ctx, ctx.match[1] ?? '', ctx.match[2] !== undefined),
  );

  // The tapping user's active ledger; a locked ledger answers locked. The warning was shown with
  // the first range step, so the step it goes back to carries it only if it was never seen.
  bot.callbackQuery(EXPORT_BACK, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const state = activeExportState(deps, user);
    if (isLocked(state)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    await showRangeStep(
      ctx,
      state.sealed && seenNotice(deps, user, 'export_plaintext', now),
      ctx.match[1] !== undefined,
    );
  });

  bot.callbackQuery(EXPORT_FORMAT, async (ctx) => {
    const range = ctx.match[1] ?? '';
    const format = ctx.match[2] === 'xlsx' ? 'xlsx' : 'csv';
    if (!isExportRange(range)) return;
    // A second tap while the first is still building is answered silently by the dispatcher.
    await guard(ctx, async () => {
      const now = deps.now();
      const user = ensureUser(deps, ctx.from.id, now);
      const data = exportActiveLedger(deps, { user, range, now });
      if (isLocked(data)) {
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      }
      await sendExport(ctx, deps, data, range, format);
    });
  });
}
