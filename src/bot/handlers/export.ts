import { InlineKeyboard, InputFile, InputMediaBuilder, type Composer, type Context } from 'grammy';
import { writeCsv } from '../../domain/export/csv.js';
import {
  expensesTable,
  isExportRange,
  itemsTable,
  type ExportRange,
} from '../../domain/export/rows.js';
import { exportActiveLedger, type LedgerExport } from '../../services/exportLedger.js';
import { isLocked } from '../../services/ledgerKeys.js';
import type { HandlerDeps } from '../bot.js';
import {
  EXPORT_BACK,
  EXPORT_FORMAT,
  EXPORT_RANGE,
  exportFormatData,
  exportRangeData,
  type ExportFormat,
} from '../callbackData.js';
import { createTapGuard } from '../callbacks.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import { ensureUser } from './start.js';

// /export (ADR-0026): a range step and a format step edited in place, then the file sent as a
// document in the same update. Nothing is written, so the picker needs no anchor: a tap reads
// the active ledger. The log carries the range, format, row count and byte size, never a cell.

// Telegram takes bot uploads up to 50 MB; past this the export fails loudly instead.
const MAX_FILE_BYTES = 45 * 1024 * 1024;

function rangeKeyboard(): InlineKeyboard {
  const button = (range: ExportRange) =>
    InlineKeyboard.text(messages.exportRangeButtons[range], exportRangeData(range));
  return InlineKeyboard.from([
    [button('tm'), button('pm')],
    [button('ty'), button('all')],
  ]);
}

function formatKeyboard(range: ExportRange): InlineKeyboard {
  return InlineKeyboard.from([
    [
      InlineKeyboard.text(messages.exportCsvButton, exportFormatData(range, 'csv')),
      InlineKeyboard.text(messages.exportXlsxButton, exportFormatData(range, 'xlsx')),
    ],
    [InlineKeyboard.text(messages.exportBackButton, EXPORT_BACK)],
  ]);
}

export interface ExportFile {
  readonly filename: string;
  readonly bytes: Buffer;
}

// The files of an export in one format: the expenses, plus the receipt items when any exported
// expense has them. The author column exists only for a shared ledger.
export function exportFiles(data: LedgerExport, format: ExportFormat): ExportFile[] {
  if (format !== 'csv') throw new Error(`export format ${format} is not built`);
  const expenses = expensesTable(
    messages.exportExpensesSheet,
    messages.exportColumns(data.ledger.defaultCurrency),
    data.expenses,
    data.ledger.kind === 'shared',
  );
  const files = [
    { filename: `${messages.exportExpensesStem}-${data.key}.csv`, bytes: writeCsv(expenses) },
  ];
  if (data.items.length > 0) {
    const items = itemsTable(messages.exportItemsSheet, messages.exportItemColumns, data.items);
    files.push({ filename: `${messages.exportItemsStem}-${data.key}.csv`, bytes: writeCsv(items) });
  }
  return files;
}

// Sends the export's files and closes the picker. An empty range sends nothing.
export async function sendExport(
  ctx: Context,
  deps: HandlerDeps,
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

export function registerExport(bot: Composer<Context>, deps: HandlerDeps): void {
  const guard = createTapGuard();

  bot.command('export', async (ctx) => {
    if (ctx.from === undefined) return;
    ensureUser(deps, ctx.from.id, deps.now());
    await replyHtml(ctx, messages.exportRangePrompt, { reply_markup: rangeKeyboard() });
  });

  bot.callbackQuery(EXPORT_RANGE, async (ctx) => {
    const range = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery();
    if (!isExportRange(range)) return;
    await editHtml(ctx, messages.exportFormatPrompt, { reply_markup: formatKeyboard(range) });
  });

  bot.callbackQuery(EXPORT_BACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.exportRangePrompt, { reply_markup: rangeKeyboard() });
  });

  bot.callbackQuery(EXPORT_FORMAT, async (ctx) => {
    const range = ctx.match[1] ?? '';
    const format = ctx.match[2] === 'xlsx' ? 'xlsx' : 'csv';
    if (!isExportRange(range)) return;
    if (format === 'xlsx') {
      await ctx.answerCallbackQuery({ text: messages.exportSoon });
      return;
    }
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
