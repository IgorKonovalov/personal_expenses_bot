import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { CurrencyCode } from '../../domain/currencies.js';
import type { AmountReading } from '../../domain/money.js';
import { recordExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { AMBIGUOUS_READING, ambiguousReadingData } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml } from '../render/html.js';
import { cardFor } from './card.js';
import { ensureUser } from './start.js';

// An ambiguous amount is asked as a reply to the user's message, with one button per reading.
// The question holds no state: a tap re-parses the replied-to message and records the chosen
// reading under that message's source key, so double taps, taps on both readings and a
// redelivered original all converge on one row.

export function ambiguousKeyboard(
  readings: readonly AmountReading[],
  currency: CurrencyCode,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const reading of readings) {
    keyboard.text(
      messages.readingButton({ amountMinor: reading.amountMinor, currency }),
      ambiguousReadingData(reading.interpretation),
    );
  }
  return keyboard;
}

export function registerAmbiguous(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(AMBIGUOUS_READING, async (ctx) => {
    const reading = ctx.match[1] === 't' ? 'thousands' : 'decimal';
    // An inaccessible message (deleted, or older than 48 hours) carries no reply_to_message.
    const question = ctx.callbackQuery.message;
    const original =
      question !== undefined && 'reply_to_message' in question
        ? question.reply_to_message
        : undefined;
    if (original?.text === undefined) {
      await ctx.answerCallbackQuery({ text: messages.ambiguousSourceUnavailable });
      return;
    }

    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = recordExpense(deps, {
      user,
      text: original.text,
      sourceKey: `tg:${original.chat.id}:${original.message_id}`,
      // Telegram dates are Unix seconds.
      occurredAt: new Date(original.date * 1000),
      now,
      reading,
    });
    if (result.kind !== 'recorded') {
      await ctx.answerCallbackQuery({ text: messages.ambiguousSourceUnavailable });
      return;
    }
    await ctx.answerCallbackQuery();
    const card = cardFor(result);
    await editHtml(ctx, card.text, { reply_markup: card.markup });
  });
}
