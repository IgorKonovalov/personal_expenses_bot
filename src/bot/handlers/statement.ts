import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Document } from 'grammy/types';
import { parseRaiffeisenRs } from '../../domain/statements/raiffeisenRs.js';
import {
  cancelStatement,
  previewStatement,
  recordStatement,
} from '../../services/importStatement.js';
import { readPdfLines } from '../../statements/pdf.js';
import type { HandlerDeps } from '../bot.js';
import {
  STATEMENT_CANCEL,
  STATEMENT_RECORD_ALL,
  STATEMENT_RECORD_WITH_MATCHED,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import type { FileDownloader } from './receipt.js';
import { ensureUser } from './start.js';

// A bank statement PDF in DM (Plan 0027): read in memory, previewed, and recorded by a tap. A
// PDF that isn't a statement falls through to the next document handler. Register before the
// receipt-image handler.

function isPdf(document: Document): boolean {
  return (
    document.mime_type === 'application/pdf' ||
    document.file_name?.toLowerCase().endsWith('.pdf') === true
  );
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
    const { file_path: filePath } = await ctx.api.getFile(document.file_id);
    if (filePath === undefined) {
      await next();
      return;
    }
    const lines = await readPdfLines(await download(filePath));
    const parsed = parseRaiffeisenRs(lines);
    deps.logger.info(
      { bytes: document.file_size, lines: lines.length, outcome: parsed.kind },
      'statement read',
    );
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
    // One button per row: the labels are long. [Записать все] only when there is something new,
    // [Записать и уже записанные] only when a recorded expense covers some row.
    const keyboard = new InlineKeyboard();
    const { fresh, matched } = preview;
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
    keyboard.text(messages.cancelButton, STATEMENT_CANCEL);
    await replyHtml(
      ctx,
      messages.statementPreview({
        period: preview.period,
        ledger: preview.ledger,
        purchaseCount: preview.purchases.length,
        alreadyCount: matched.length + preview.imported.length,
        fresh,
      }),
      { reply_markup: keyboard },
    );
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
