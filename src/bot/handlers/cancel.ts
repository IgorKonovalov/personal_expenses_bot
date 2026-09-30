import type { Composer, Context } from 'grammy';
import { cancelFlow } from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import { FLOW_CANCEL } from '../callbackData.js';
import { restoreScreen } from '../flows.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { requireScreen } from '../screens.js';
import { ensureUser } from './start.js';

// /cancel and [Отмена] abort the pending flow and put the anchor back to the screen the flow
// started from (ADR-0009).
export function registerCancel(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('cancel', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    if (!cancelFlow(deps, user)) {
      await replyHtml(ctx, messages.nothingToCancel);
      return;
    }
    await restoreScreen(ctx, deps, user);
  });

  // A screen callback: only the anchor carries a live [Отмена].
  bot.callbackQuery(FLOW_CANCEL, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    cancelFlow(deps, tap.user);
    await ctx.answerCallbackQuery();
    await restoreScreen(ctx, deps, tap.user);
  });
}
