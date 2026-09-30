import type { Composer, Context } from 'grammy';
import { recordExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { ambiguousKeyboard, registerAmbiguous } from './ambiguous.js';
import { cardFor } from './card.js';
import { sendHelp } from './help.js';
import { ensureUser } from './start.js';

// Free text is an expense attempt. Register after command handlers. The taps on the ambiguous
// amount question it asks are registered with it.
export function registerText(bot: Composer<Context>, deps: HandlerDeps): void {
  registerAmbiguous(bot, deps);

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
      case 'recorded': {
        // A redelivery of a message whose expense was deleted since gets the deleted card.
        const card = cardFor(result);
        await replyHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
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
        await sendHelp(ctx);
        return;
      case 'readingUnavailable':
        throw new Error('no reading was chosen for a text message');
    }
  });
}
