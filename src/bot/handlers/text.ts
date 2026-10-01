import type { Composer, Context } from 'grammy';
import { parseBankSms } from '../../domain/bankSms/index.js';
import { decodeReceiptUrl } from '../../domain/receipts/index.js';
import { cancelFlow, routeText } from '../../services/flowSessions.js';
import { recordBankSms } from '../../services/recordBankSms.js';
import { recordExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { answerFlow } from '../flows.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { ambiguousKeyboard, registerAmbiguous } from './ambiguous.js';
import { cardFor, cardView } from './card.js';
import { sendHelp } from './help.js';
import { answerReceipt } from './receipt.js';
import { ensureUser } from './start.js';

// Text that isn't a command or a menu tap, routed by ADR-0009: a redelivered flow answer is
// ignored, a pending flow takes the text as its answer, and anything else is an expense attempt.
// Register after command handlers. The taps on the ambiguous amount question it asks are
// registered with it.
export function registerText(bot: Composer<Context>, deps: HandlerDeps): void {
  registerAmbiguous(bot, deps);

  bot.on('message:text', async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const sourceKey = `tg:${ctx.chat.id}:${ctx.message.message_id}`;
    const route = routeText(deps, { user, inputKey: sourceKey, now });
    if (route.kind === 'redelivered') return;
    if (route.kind === 'flow') {
      await answerFlow(ctx, deps, {
        user,
        flow: route.flow,
        text: ctx.message.text,
        inputKey: sourceKey,
      });
      return;
    }

    // Telegram dates are Unix seconds.
    const occurredAt = new Date(ctx.message.date * 1000);

    // A message that is a receipt verification link, and nothing else, records the receipt.
    const receipt = decodeReceiptUrl(ctx.message.text);
    if (receipt.kind !== 'notReceipt') {
      await answerReceipt(ctx, deps, { user, decoded: receipt, occurredAt, now });
      return;
    }

    // A message that is one bank card-purchase SMS records the purchase (ADR-0021).
    const sms = parseBankSms(ctx.message.text);
    if (sms.kind === 'purchase') {
      const recorded = recordBankSms(deps, { user, sms, occurredAt, now });
      const card = cardFor(cardView(deps, user, recorded));
      await replyHtml(ctx, recorded.duplicate ? messages.alreadyRecorded(card.text) : card.text, {
        reply_markup: card.markup,
      });
      return;
    }

    const result = recordExpense(deps, {
      user,
      text: ctx.message.text,
      sourceKey,
      occurredAt,
      now,
    });

    switch (result.kind) {
      case 'recorded': {
        // A redelivery of a message whose expense was deleted since gets the deleted card.
        const card = cardFor(cardView(deps, user, result));
        await replyHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'futureDate':
        await replyHtml(ctx, messages.futureDate);
        return;
      case 'ambiguous':
        await replyHtml(
          ctx,
          messages.ambiguousAmount({
            readings: result.readings.map((r) => ({
              amountMinor: r.amountMinor,
              currency: result.currency,
            })),
          }),
          {
            reply_parameters: { message_id: ctx.message.message_id },
            reply_markup: ambiguousKeyboard(result.readings, result.currency),
          },
        );
        return;
      case 'invalid':
        await replyHtml(ctx, messages.invalidAmount);
        return;
      case 'notExpense':
        // A late answer to an expired prompt: say so once, and drop the flow.
        if (route.expiredFlow) {
          cancelFlow(deps, user);
          await replyHtml(ctx, messages.flowExpired);
          return;
        }
        await sendHelp(ctx);
        return;
      case 'readingUnavailable':
        throw new Error('no reading was chosen for a text message');
    }
  });
}
