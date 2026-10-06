import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Document } from 'grammy/types';
import { parseRaiffeisenRs } from '../../domain/statements/raiffeisenRs.js';
import {
  cancelStatement,
  MAX_STATEMENT_BYTES,
  MAX_STATEMENT_PAGES,
  pendingStatementPreview,
  previewStatement,
  recordStatement,
  type StatementPreview,
} from '../../services/importStatement.js';
import { readPdfLines, type PdfText } from '../../statements/pdf.js';
import type { HandlerDeps } from '../bot.js';
import {
  STATEMENT_CANCEL,
  STATEMENT_PAGE,
  STATEMENT_RECORD_ALL,
  STATEMENT_RECORD_WITH_MATCHED,
  statementPageData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow } from '../nav.js';
import { editHtml, replyHtml } from '../render/html.js';
import type { FileDownloader } from './receipt.js';
import { ensureUser } from './start.js';

// A bank statement PDF in DM (Plan 0027): read in memory, previewed, and recorded by a tap. A
// PDF that isn't a statement falls through to the next document handler. Register before the
// receipt-image handler.

// Rows per preview page.
const ROWS_PER_PAGE = 10;

function isPdf(document: Document): boolean {
  return (
    document.mime_type === 'application/pdf' ||
    document.file_name?.toLowerCase().endsWith('.pdf') === true
  );
}

// The preview's text and buttons at a 1-based page: the new rows, then the rows a recorded
// expense covers, ROWS_PER_PAGE at a time.
function previewView(preview: StatementPreview, requestedPage: number) {
  const { fresh, matched } = preview;
  const rows = [
    ...fresh.map((row) => ({ ...row, already: false })),
    ...matched.map((row) => ({ ...row, already: true })),
  ];
  const shown = pageOf(rows, requestedPage, ROWS_PER_PAGE);
  // One button per row: the labels are long. [Записать все] only when there is something new,
  // [Записать и уже записанные] only when a recorded expense covers some row.
  const keyboard = new InlineKeyboard();
  if (fresh.length > 0) {
    keyboard.text(messages.statementRecordAllButton(fresh.length), STATEMENT_RECORD_ALL).row();
  }
  if (matched.length > 0) {
    keyboard
      .text(
        messages.statementRecordWithMatchedButton(fresh.length + matched.length),
        STATEMENT_RECORD_WITH_MATCHED,
      )
      .row();
  }
  const pager = pagerRow(shown, statementPageData);
  if (pager.length > 0) keyboard.add(...pager).row();
  keyboard.text(messages.cancelButton, STATEMENT_CANCEL);
  return {
    text: messages.statementPreview({
      period: preview.period,
      ledger: preview.ledger,
      purchaseCount: preview.purchases.length,
      alreadyCount: matched.length + preview.imported.length,
      fresh,
      rows: shown.items,
    }),
    markup: keyboard,
  };
}

export function registerStatement(
  bot: Composer<Context>,
  deps: HandlerDeps,
  download: FileDownloader,
): void {
  bot.on('message:document', async (ctx, next) => {
    const { document } = ctx.message;
    if (!isPdf(document)) {
      await next();
      return;
    }
    // One info line per PDF: sizes, counts and outcomes, never a merchant, an amount or the
    // account number. An error is logged by its class alone.
    const read = { bytes: document.file_size };
    if ((document.file_size ?? 0) > MAX_STATEMENT_BYTES) {
      deps.logger.info({ ...read, outcome: 'tooLarge' }, 'statement read');
      await replyHtml(ctx, messages.statementTooLarge);
      return;
    }
    const { file_path: filePath } = await ctx.api.getFile(document.file_id);
    if (filePath === undefined) {
      await next();
      return;
    }
    let text: PdfText;
    try {
      text = await readPdfLines(await download(filePath), { maxPages: MAX_STATEMENT_PAGES });
    } catch (error) {
      deps.logger.info(
        { ...read, outcome: 'unreadable', error: error instanceof Error ? error.name : 'NonError' },
        'statement read',
      );
      await replyHtml(ctx, messages.statementUnreadable);
      return;
    }
    if (text.kind === 'tooManyPages') {
      deps.logger.info({ ...read, pages: text.pages, outcome: 'tooLong' }, 'statement read');
      await replyHtml(ctx, messages.statementTooLong);
      return;
    }
    if (text.lines.length === 0) {
      deps.logger.info({ ...read, outcome: 'noText' }, 'statement read');
      await replyHtml(ctx, messages.statementNoText);
      return;
    }
    const parsed = parseRaiffeisenRs(text.lines);
    deps.logger.info({ ...read, lines: text.lines.length, outcome: parsed.kind }, 'statement read');
    if (parsed.kind === 'notThisStatement') {
      await next();
      return;
    }

    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const preview = previewStatement(deps, {
      user,
      period: parsed.period,
      purchases: parsed.purchases,
      now,
    });
    if (preview.kind === 'tooLong') {
      await replyHtml(ctx, messages.statementTooLong);
      return;
    }
    const view = previewView(preview, 1);
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(STATEMENT_PAGE, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const preview = pendingStatementPreview(deps, { user, now });
    await ctx.answerCallbackQuery();
    if (preview.kind === 'expired') {
      await editHtml(ctx, messages.flowExpired);
      return;
    }
    const view = previewView(preview, Number(ctx.match[1]));
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  for (const [data, withMatched] of [
    [STATEMENT_RECORD_ALL, false],
    [STATEMENT_RECORD_WITH_MATCHED, true],
  ] as const) {
    bot.callbackQuery(data, async (ctx) => {
      const now = deps.now();
      const user = ensureUser(deps, ctx.from.id, now);
      const result = recordStatement(deps, { user, now, withMatched });
      if (result.kind === 'expired') {
        await ctx.answerCallbackQuery();
        await editHtml(ctx, messages.flowExpired);
        return;
      }
      await ctx.answerCallbackQuery({ text: messages.statementRecordedToast });
      await editHtml(ctx, messages.statementRecorded(result));
    });
  }

  bot.callbackQuery(STATEMENT_CANCEL, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    cancelStatement(deps, { user, now });
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.statementCancelled);
  });
}
