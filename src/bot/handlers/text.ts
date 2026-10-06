import type { Composer, Context } from 'grammy';
import type { User } from '../../db/users.js';
import { parseBankSms } from '../../domain/bankSms/index.js';
import type { BankSmsResult } from '../../domain/bankSms/types.js';
import { decodeReceiptUrl } from '../../domain/receipts/index.js';
import { cancelFlow, routeText } from '../../services/flowSessions.js';
import { recordBankSms } from '../../services/recordBankSms.js';
import { recordExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { answerFlow } from '../flows.js';
import { messages } from '../messages.js';
import { joinHtml, replyHtml } from '../render/html.js';
import { ambiguousKeyboard, registerAmbiguous } from './ambiguous.js';
import { cardFor, cardView } from './card.js';
import { offerSplit } from './debts.js';
import { sendHelp } from './help.js';
import type { MoreDeps } from './more.js';
import { answerReceipt } from './receipt.js';
import { ensureUser } from './start.js';
import { answerExpiredSecret } from './unlock.js';

// Text that isn't a command or a menu tap, routed by ADR-0009: a redelivered flow answer is
// ignored, a pending flow takes the text as its answer, and anything else is an expense attempt.
// Register after command handlers. The taps on the ambiguous amount question it asks are
// registered with it.
export function registerText(bot: Composer<Context>, deps: MoreDeps): void {
  registerAmbiguous(bot, deps);

  bot.on('message:text', async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const sourceKey = `tg:${ctx.chat.id}:${ctx.message.message_id}`;
    const route = routeText(deps, { user, inputKey: sourceKey, now });
    if (route.kind === 'redelivered') return;
    if (route.kind === 'expiredSecret') {
      await answerExpiredSecret(ctx, deps, user);
      return;
    }
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

    // A message that is one bank card-purchase SMS records the purchase (ADR-0021). One whose
    // header matched but whose body didn't is refused, never read as free text.
    const sms = parseBankSms(ctx.message.text);
    if (sms.kind !== 'notBankSms') {
      await answerBankSms(ctx, deps, { user, sms, messageKey: sourceKey, occurredAt, now });
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
        const { split } = result;
        if (split === undefined) {
          await replyHtml(ctx, card.text, { reply_markup: card.markup });
          return;
        }
        // A `/N` split: the card says what the share is of, then the picker asks who owes the
        // rest. A redelivery starts no second picker.
        const whole = { amountMinor: split.whole, currency: result.expense.currency };
        const sent = await replyHtml(
          ctx,
          joinHtml([card.text, messages.splitShare(whole, split.parts)], '\n'),
          { reply_markup: card.markup },
        );
        if (!result.duplicate) {
          await offerSplit(ctx, deps, {
            user,
            expense: result.expense,
            split,
            cardMessageId: sent.message_id,
            sourceKey,
          });
        }
        return;
      }
      case 'splitInGroup':
        await replyHtml(ctx, messages.splitInGroup);
        return;
      case 'sealedDuplicate':
        await replyHtml(ctx, messages.sealedDuplicate);
        return;
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
      case 'tooManyTags':
        await replyHtml(ctx, messages.tooManyTags);
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

async function answerBankSms(
  ctx: Context,
  deps: HandlerDeps,
  input: {
    readonly user: User;
    readonly sms: Exclude<BankSmsResult, { kind: 'notBankSms' }>;
    readonly messageKey: string;
    // The Telegram message date.
    readonly occurredAt: Date;
    readonly now: Date;
  },
): Promise<void> {
  const { user, sms } = input;
  if (sms.kind === 'refused') {
    await replyHtml(
      ctx,
      sms.reason === 'malformed'
        ? messages.bankSmsRefused.malformed
        : messages.bankSmsRefused.unsupportedCurrency(sms.code),
    );
    return;
  }
  const result = recordBankSms(deps, {
    user,
    sms,
    messageKey: input.messageKey,
    occurredAt: input.occurredAt,
    now: input.now,
  });
  if (result.kind === 'futureSms') {
    await replyHtml(ctx, messages.bankSmsFuture);
    return;
  }
  if (result.kind === 'sealedDuplicate') {
    await replyHtml(ctx, messages.sealedDuplicate);
    return;
  }
  const card = cardFor(cardView(deps, user, result));
  await replyHtml(ctx, result.duplicate ? messages.alreadyRecorded(card.text) : card.text, {
    reply_markup: card.markup,
  });
}
