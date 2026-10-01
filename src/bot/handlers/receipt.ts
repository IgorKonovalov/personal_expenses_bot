import type { Composer, Context } from 'grammy';
import type { User } from '../../db/users.js';
import { decodeReceiptUrl } from '../../domain/receipts/index.js';
import type { DecodeReceiptResult } from '../../domain/receipts/types.js';
import { decodeQr } from '../../fiscal/qr.js';
import { receiptItems, rememberReceiptCard, retryReceipt } from '../../services/fetchDueReceipt.js';
import { recordReceipt } from '../../services/recordReceipt.js';
import type { HandlerDeps } from '../bot.js';
import {
  RECEIPT_ITEMS,
  RECEIPT_RETRY,
  receiptItemsData,
  showExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { kickReceiptWorker } from '../receiptWorker.js';
import { editHtml, replyHtml } from '../render/html.js';
import { cardFor, cardView, expenseIdOf } from './card.js';
import { ensureUser } from './start.js';

// A decoded receipt URL, from a pasted link or a photo's QR, in DM (ADR-0018): records the
// receipt's total into the active ledger and answers with the card, or with «уже записано» and
// the existing card for a receipt this ledger already has.
export async function answerReceipt(
  ctx: Context,
  deps: HandlerDeps,
  input: {
    readonly user: User;
    readonly decoded: Exclude<DecodeReceiptResult, { kind: 'notReceipt' }>;
    // The Telegram message date.
    readonly occurredAt: Date;
    readonly now: Date;
  },
): Promise<void> {
  const { user, decoded } = input;
  if (decoded.kind === 'refused') {
    await replyHtml(ctx, messages.receiptRefused[decoded.reason]);
    return;
  }

  const result = recordReceipt(deps, {
    user,
    receipt: decoded.receipt,
    placeholder: messages.receiptPlaceholder,
    occurredAt: input.occurredAt,
    now: input.now,
  });
  if (result.kind === 'futureReceipt') {
    await replyHtml(ctx, messages.futureReceipt);
    return;
  }

  const card = cardFor(cardView(deps, user, result));
  const sent = await replyHtml(
    ctx,
    result.duplicate ? messages.alreadyRecorded(card.text) : card.text,
    { reply_markup: card.markup },
  );
  // The newest card is the one the worker edits once the items arrive. The test fake answers
  // every call with `true`, which carries no message id.
  if (Number.isInteger(sent.message_id)) {
    rememberReceiptCard(deps, result.receipt.id, {
      chatId: sent.chat.id,
      messageId: sent.message_id,
    });
  }
}

// A receipt card's [Позиции], paging through the items in the card, and [Повторить], which
// refetches a failed receipt. Registered by registerCard.
export function registerReceiptCard(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(RECEIPT_ITEMS, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = receiptItems(deps, { user, expenseId });
    switch (result.kind) {
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.receiptItemsForbidden });
        return;
      case 'notFetched':
        await ctx.answerCallbackQuery({ text: messages.receiptItemsUnavailable });
        return;
      case 'items':
        break;
    }
    await ctx.answerCallbackQuery();
    const pages = messages.receiptItemPages({
      sellerName: result.sellerName,
      currency: result.expense.currency,
      items: result.items,
    });
    // One rendered page per pager page; a page number past the end shows the last one.
    const shown = pageOf(pages, Number(ctx.match[2]), 1);
    const [text] = shown.items;
    if (text === undefined) return;
    await editHtml(ctx, text, {
      reply_markup: pickerKeyboard(
        [],
        pagerRow(shown, (page) => receiptItemsData(expenseId, page)),
        showExpenseData(expenseId),
      ),
    });
  });

  bot.callbackQuery(RECEIPT_RETRY, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = retryReceipt(deps, { user, expenseId, now });
    switch (result.kind) {
      case 'retrying': {
        kickReceiptWorker();
        await ctx.answerCallbackQuery({ text: messages.receiptRetryToast });
        const card = cardFor(cardView(deps, user, result));
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'notFailed':
        await ctx.answerCallbackQuery({ text: messages.receiptRetryNotFailed });
        return;
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.receiptRetryForbidden });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
    }
  });
}

// Bots may download files of at most 20 MB through getFile.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// Fetches a file by the path getFile returned. The URL carries the bot token, so neither it nor
// anything derived from it reaches an error message or a log.
export type FileDownloader = (filePath: string) => Promise<Uint8Array>;

export function telegramFileDownloader(token: string): FileDownloader {
  return async (filePath) => {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    } catch {
      throw new Error('telegram file download failed');
    }
    if (!response.ok) throw new Error(`telegram file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

// A photo, or an image sent as a file, in DM: the first QR text that is a receipt URL runs the
// pasted-link path (ADR-0019). An image with no such QR gets one hint. A non-image document
// falls through to the help reply. Register before the non-text handler.
export function registerReceiptMedia(
  bot: Composer<Context>,
  deps: HandlerDeps,
  download: FileDownloader,
): void {
  bot.on(['message:photo', 'message:document'], async (ctx, next) => {
    const { document, photo } = ctx.message;
    if (document !== undefined && document.mime_type?.startsWith('image/') !== true) {
      await next();
      return;
    }
    // Telegram lists a photo's sizes smallest first.
    const file = document ?? photo.at(-1);
    if (file === undefined) {
      await next();
      return;
    }
    if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
      await replyHtml(ctx, messages.receiptPhotoHint);
      return;
    }

    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const { file_path: filePath } = await ctx.api.getFile(file.file_id);
    if (filePath === undefined) {
      await replyHtml(ctx, messages.receiptPhotoHint);
      return;
    }
    const qr = await decodeQr(await download(filePath));
    const decoded =
      qr.kind === 'none'
        ? undefined
        : qr.texts.map(decodeReceiptUrl).find((result) => result.kind !== 'notReceipt');
    if (decoded === undefined) {
      await replyHtml(ctx, messages.receiptPhotoHint);
      return;
    }
    await answerReceipt(ctx, deps, {
      user,
      decoded,
      occurredAt: new Date(ctx.message.date * 1000),
      now,
    });
  });
}
