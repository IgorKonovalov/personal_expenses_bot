import type { Composer, Context } from 'grammy';
import { todaySummary } from '../../services/todaySummary.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { offerTip } from '../tips.js';
import { ensureUser } from './start.js';

// Shared by /today and the 📊 menu button.
export async function sendToday(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  const summary = todaySummary(deps, { user, now });
  if ('kind' in summary) {
    await replyHtml(ctx, messages.ledgerLocked);
    return;
  }
  await replyHtml(ctx, messages.today(summary));
  await offerTip(ctx, deps, user, 'todayShown');
}

export function registerToday(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('today', (ctx) => sendToday(ctx, deps));
}
