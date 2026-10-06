import { GrammyError, InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense } from '../db/expenses.js';
import type { User } from '../db/users.js';
import type { TipTrigger } from '../domain/tips.js';
import { switchTips, takeTip } from '../services/tips.js';
import type { HandlerDeps } from './bot.js';
import { TIPS_OFF } from './callbackData.js';
import { messages } from './messages.js';
import { ensureUser } from './handlers/start.js';
import { replyHtml } from './render/html.js';

// The adapter half of ADR-0028: a handler that just replied offers its trigger once. The service
// decides and records; this sends the tip as its own message with [Отключить подсказки].
export async function offerTip(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  trigger: TipTrigger,
  tipContext: { readonly expense?: Expense } = {},
): Promise<void> {
  const offer = takeTip(deps, {
    user,
    trigger,
    privateChat: ctx.chat?.type === 'private',
    ...tipContext,
    now: deps.now(),
  });
  if (offer === undefined) return;
  await replyHtml(ctx, messages.tips[offer.key](offer.view), {
    reply_markup: InlineKeyboard.from([[InlineKeyboard.text(messages.tipsOffButton, TIPS_OFF)]]),
  });
}

// [Отключить подсказки]: tips off, the toast says how to switch them back on, and the button
// leaves that tip. A repeat tap finds tips off and the button gone already.
export function registerTipsOff(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(TIPS_OFF, async (ctx) => {
    switchTips(deps, ensureUser(deps, ctx.from.id, deps.now()), false);
    await ctx.answerCallbackQuery({ text: messages.tipsOff });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes('message is not modified')) {
        return;
      }
      throw error;
    }
  });
}
