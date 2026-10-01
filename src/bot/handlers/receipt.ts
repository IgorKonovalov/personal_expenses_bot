import type { Context } from 'grammy';
import type { User } from '../../db/users.js';
import type { DecodeReceiptResult } from '../../domain/receipts/types.js';
import { recordReceipt } from '../../services/recordReceipt.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { cardFor, cardView } from './card.js';

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
  await replyHtml(ctx, result.duplicate ? messages.receiptAlreadyRecorded(card.text) : card.text, {
    reply_markup: card.markup,
  });
}
