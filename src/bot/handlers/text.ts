import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { recordExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { undoExpenseData } from '../callbackData.js';
import { messages } from '../messages.js';
import { ensureUser } from './start.js';

// Free text is an expense attempt. Register after command handlers.
export function registerText(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.on('message:text', async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = recordExpense(deps, {
      user,
      text: ctx.message.text,
      sourceKey: `tg:${ctx.chat.id}:${ctx.message.message_id}`,
      // Telegram dates are Unix seconds.
      occurredAt: new Date(ctx.message.date * 1000),
      now,
    });

    switch (result.kind) {
      case 'recorded':
        await ctx.reply(messages.expenseRecorded(result), {
          reply_markup: new InlineKeyboard().text(
            messages.undoButton,
            undoExpenseData(result.expense.id),
          ),
        });
        return;
      case 'ambiguous':
        await ctx.reply(
          messages.ambiguousAmount({
            readings: result.readings.map((r) => ({
              amountMinor: r.amountMinor,
              currency: result.currency,
            })),
            description: result.description,
            currency: result.currency,
            defaultCurrency: result.ledger.defaultCurrency,
          }),
        );
        return;
      case 'invalid':
        await ctx.reply(messages.invalidAmount);
        return;
      case 'notExpense':
        await ctx.reply(messages.help);
        return;
    }
  });
}
