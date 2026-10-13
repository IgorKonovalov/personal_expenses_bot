import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import { parseWoltRs } from '../../domain/orders/woltRs.js';
import type { PositionedLine } from '../../domain/statements/types.js';
import {
  answerOrder,
  cancelOrder,
  importOrder,
  type OrderRecorded,
} from '../../services/importOrder.js';
import type { HandlerDeps } from '../bot.js';
import { ORDER_CANCEL, ORDER_NEW, ORDER_SAME } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml, type Html } from '../render/html.js';
import { cardFor, cardView, type Card } from './card.js';
import { sendStrayReply } from './help.js';
import { ensureUser } from './start.js';

// A delivery order PDF in DM (Plan 0051), handed over by the statement handler once the PDF is
// not a statement. A new order is recorded with its dishes and answered with its card; one that
// matches a recorded expense is asked about first, and its buttons act on the order the flow
// session holds.

// A PDF that isn't a statement: an order is recorded or asked about, and anything else gets
// what the handlers after the statement handler gave it before the hand-off. No receipt-image
// or other document handler takes a PDF, so it is the stray-message reply. `logRead` writes the
// PDF's one info line.
export async function answerOrderPdf(
  ctx: Context,
  deps: HandlerDeps,
  input: {
    readonly fromId: number;
    readonly lines: readonly PositionedLine[];
    readonly sentAt: Date;
    readonly logRead: (outcome: string) => void;
  },
): Promise<void> {
  const parsed = parseWoltRs(input.lines);
  if (parsed.kind === 'notThisOrder') {
    input.logRead('notThisStatement');
    await sendStrayReply(ctx, deps);
    return;
  }
  if (parsed.kind === 'unreadableOrder') {
    input.logRead('orderUnreadable');
    await replyHtml(ctx, messages.orderUnreadable);
    return;
  }
  const now = deps.now();
  const user = ensureUser(deps, input.fromId, now);
  const result = importOrder(deps, { user, order: parsed.order, sentAt: input.sentAt, now });
  switch (result.kind) {
    case 'sealedLedger':
      input.logRead('orderSealedLedger');
      await replyHtml(ctx, messages.receiptSealedLedger);
      return;
    case 'futureOrder':
      input.logRead('orderFuture');
      await replyHtml(ctx, messages.futureReceipt);
      return;
    case 'asked':
      input.logRead('orderAsked');
      await replyHtml(ctx, messages.orderAsk(result.candidate), {
        reply_markup: new InlineKeyboard()
          .text(messages.orderSameButton, ORDER_SAME)
          .row()
          .text(messages.orderNewButton, ORDER_NEW)
          .row()
          .text(messages.cancelButton, ORDER_CANCEL),
      });
      return;
    case 'recorded': {
      input.logRead(result.duplicate ? 'orderDuplicate' : 'order');
      const card = cardOf(deps, user, result);
      await replyHtml(ctx, result.duplicate ? messages.alreadyRecorded(card.text) : card.text, {
        reply_markup: card.markup,
      });
      return;
    }
  }
}

function cardOf(
  deps: HandlerDeps,
  user: User,
  result: Pick<OrderRecorded, 'expense' | 'ledger'>,
): Card {
  return cardFor(cardView(deps, user, result));
}

export function registerOrder(bot: Composer<Context>, deps: HandlerDeps): void {
  for (const [data, answer] of [
    [ORDER_SAME, 'same'],
    [ORDER_NEW, 'new'],
  ] as const) {
    bot.callbackQuery(data, async (ctx) => {
      const now = deps.now();
      const user = ensureUser(deps, ctx.from.id, now);
      const result = answerOrder(deps, { user, answer, now });
      await ctx.answerCallbackQuery();
      if (result.kind === 'expired') {
        await editHtml(ctx, messages.flowExpired);
        return;
      }
      if (result.kind === 'sealedLedger') {
        await editHtml(ctx, messages.receiptSealedLedger);
        return;
      }
      const card = cardOf(deps, user, result);
      const text: Html =
        result.kind === 'hasItems'
          ? messages.orderHasItems(card.text)
          : result.kind === 'recorded' && result.duplicate
            ? messages.alreadyRecorded(card.text)
            : result.kind === 'recorded' && result.candidateGone
              ? messages.orderCandidateGone(card.text)
              : card.text;
      await editHtml(ctx, text, { reply_markup: card.markup });
    });
  }

  bot.callbackQuery(ORDER_CANCEL, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const cancelled = cancelOrder(deps, { user, now });
    await ctx.answerCallbackQuery();
    await editHtml(ctx, cancelled ? messages.orderCancelled : messages.flowExpired);
  });
}
