import type { Composer, Context } from 'grammy';
import type { User } from '../../db/users.js';
import { decodeReceiptUrl } from '../../domain/receipts/index.js';
import type { DecodeReceiptResult } from '../../domain/receipts/types.js';
import type { Job, JobResult } from '../../jobs/queue.js';
import { receiptItems, rememberReceiptCard, retryReceipt } from '../../services/fetchDueReceipt.js';
import { RECEIPTS_PER_DAY, recordReceipt } from '../../services/recordReceipt.js';
import { tidyChatOn } from '../../services/settings.js';
import type { AdminDeps, HandlerDeps } from '../bot.js';
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
import { offerTip } from '../tips.js';
import { cardAt, cardFor, cardView, expenseIdOf, tappedMessage } from './card.js';
import { ensureUser } from './start.js';

export type ReceiptOutcome =
  'recorded' | 'duplicate' | 'refused' | 'capReached' | 'futureReceipt' | 'sealedLedger';

// A decoded receipt URL, from a pasted link or a photo's QR, in DM (ADR-0018): records the
// receipt's total into the active ledger and answers with the card, or with «уже записано» and
// the existing card for a receipt this ledger already has. Returns what happened.
export async function answerReceipt(
  ctx: Context,
  deps: AdminDeps,
  input: {
    readonly user: User;
    readonly decoded: Exclude<DecodeReceiptResult, { kind: 'notReceipt' }>;
    // The Telegram message date.
    readonly occurredAt: Date;
    readonly now: Date;
  },
): Promise<ReceiptOutcome> {
  const { user, decoded } = input;
  if (decoded.kind === 'refused') {
    await replyHtml(ctx, messages.receiptRefused[decoded.reason]);
    return 'refused';
  }

  const result = recordReceipt(deps, {
    user,
    receipt: decoded.receipt,
    placeholder: messages.receiptPlaceholder,
    occurredAt: input.occurredAt,
    now: input.now,
    // The admin is exempt from the daily cap (ADR-0024).
    dailyCap: ctx.from?.id === deps.adminTelegramId ? undefined : RECEIPTS_PER_DAY,
  });
  if (result.kind === 'capReached') {
    await replyHtml(ctx, messages.receiptCapReached);
    return 'capReached';
  }
  if (result.kind === 'futureReceipt') {
    await replyHtml(ctx, messages.futureReceipt);
    return 'futureReceipt';
  }
  if (result.kind === 'sealedLedger') {
    await replyHtml(ctx, messages.receiptSealedLedger);
    return 'sealedLedger';
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
  await offerTip(ctx, deps, user, 'expenseRecorded', {
    expense: result.expense,
    fromReceipt: true,
  });
  return result.duplicate ? 'duplicate' : 'recorded';
}

// What a deleted user message was: a receipt photo, always deleted once recorded, or a text the
// tidy chat switch deletes once it recorded an expense (ADR-0038).
export type RecordedSource = 'receiptPhoto' | 'recordedText';

const DELETE_FAILED: Readonly<Record<RecordedSource, string>> = {
  receiptPhoto: 'receipt photo delete failed',
  recordedText: 'recorded message delete failed',
};

// Deletes the user's private message a card now stands for: the update's own message, or
// `target`. A bot may delete an incoming private message for 48 hours; a delete that fails, a
// redelivered one included, costs only the delete and logs the update id and the error name.
export async function deleteRecordedMessage(
  ctx: Context,
  deps: HandlerDeps,
  source: RecordedSource,
  target?: { readonly chatId: number; readonly messageId: number },
): Promise<void> {
  try {
    await (target === undefined
      ? ctx.deleteMessage()
      : ctx.api.deleteMessage(target.chatId, target.messageId));
  } catch (error) {
    deps.logger.warn(
      { updateId: ctx.update.update_id, err: error instanceof Error ? error.name : typeof error },
      DELETE_FAILED[source],
    );
  }
}

// Under the tidy chat switch (ADR-0038): deletes the user's message once it recorded an expense.
export async function tidyAfterRecording(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  target?: { readonly chatId: number; readonly messageId: number },
): Promise<void> {
  if (ctx.chat?.type !== 'private' || !tidyChatOn(deps, user)) return;
  await deleteRecordedMessage(ctx, deps, 'recordedText', target);
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
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
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
        const view = cardView(deps, user, result);
        const card = cardAt(deps, user, tappedMessage(ctx), view, cardFor(view));
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

// The heavy-job queue as the handlers see it (ADR-0042): `then` runs with the job's result once
// it settles, with the update's ctx, after the handler has returned. An error it throws is
// logged and answered as the error boundary would. `full`: nothing was queued.
export interface HeavyJobs {
  readonly enqueue: (
    ctx: Context,
    job: Job,
    then: (result: JobResult) => Promise<void>,
  ) => 'queued' | 'full';
}

// A photo, or an image sent as a file, in DM: the first QR text that is a receipt URL runs the
// pasted-link path (ADR-0019), and a recorded or duplicate receipt's image is then deleted. An
// image with no such QR gets one hint and stays. A non-image document falls through to the
// help reply. Register before the non-text handler. The download and the decode run in the
// heavy-job queue; the handler returns once the job is queued, and the continuation does the
// rest. A redelivered photo queues a second job, and recording dedups it (ADR-0018).
export function registerReceiptMedia(
  bot: Composer<Context>,
  deps: AdminDeps,
  jobs: HeavyJobs,
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
    // One info line per image, whatever the outcome, so an unread receipt can be diagnosed from
    // the log. It carries sizes and decoder diagnostics, never the QR text.
    const read = {
      source: document === undefined ? 'photo' : 'document',
      bytes: file.file_size,
      ...('width' in file ? { width: file.width, height: file.height } : {}),
    };
    if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
      deps.logger.info({ ...read, outcome: 'tooLarge' }, 'receipt image read');
      await replyHtml(ctx, messages.receiptPhotoNoQr);
      return;
    }

    ensureUser(deps, ctx.from.id, deps.now());
    const { file_path: filePath } = await ctx.api.getFile(file.file_id);
    if (filePath === undefined) {
      deps.logger.info({ ...read, outcome: 'noFilePath' }, 'receipt image read');
      await replyHtml(ctx, messages.receiptPhotoNoQr);
      return;
    }
    const fromId = ctx.from.id;
    const occurredAt = new Date(ctx.message.date * 1000);
    // From the hand-off: the wait in the queue, the child's start, the download and the decode.
    const started = performance.now();
    const queued = jobs.enqueue(ctx, { kind: 'qr', filePath }, async (job) => {
      const ms = Math.round(performance.now() - started);
      if (job.kind === 'timeout') {
        deps.logger.info({ ...read, ms, outcome: 'timeout' }, 'receipt image read');
        await replyHtml(ctx, messages.receiptPhotoUnreadable);
        return;
      }
      if (job.kind !== 'qr') {
        throw new Error(`receipt job failed: ${job.kind === 'failed' ? job.error : job.kind}`);
      }
      const qr = job.result;
      const decoded =
        qr.kind === 'none'
          ? undefined
          : qr.texts.map(decodeReceiptUrl).find((result) => result.kind !== 'notReceipt');
      deps.logger.info(
        {
          ...read,
          ms,
          outcome: decoded !== undefined ? 'receipt' : qr.kind === 'none' ? 'noQr' : 'notReceipt',
          ...(qr.kind === 'none' && qr.detected !== undefined ? { detected: qr.detected } : {}),
          ...(qr.kind === 'none' && qr.pixelDecode !== undefined
            ? { pixelDecode: qr.pixelDecode }
            : {}),
          ...(qr.kind === 'decoded' ? { qrCount: qr.texts.length, pass: qr.pass } : {}),
        },
        'receipt image read',
      );
      if (decoded === undefined) {
        await replyHtml(
          ctx,
          qr.kind === 'none' && qr.detected !== undefined
            ? messages.receiptPhotoUnreadable
            : messages.receiptPhotoNoQr,
        );
        return;
      }
      // Read again: the user may have switched ledgers while the job ran.
      const now = deps.now();
      const user = ensureUser(deps, fromId, now);
      const outcome = await answerReceipt(ctx, deps, { user, decoded, occurredAt, now });
      // Recorded or already recorded: the card carries everything the photo said.
      if (outcome === 'recorded' || outcome === 'duplicate') {
        await deleteRecordedMessage(ctx, deps, 'receiptPhoto');
      }
    });
    if (queued === 'full') {
      deps.logger.info({ ...read, outcome: 'busy' }, 'receipt image read');
      await replyHtml(ctx, messages.heavyJobBusy);
    }
  });
}
