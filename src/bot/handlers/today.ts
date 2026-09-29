import type { Composer, Context } from 'grammy';
import { todaySummary } from '../../services/todaySummary.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { ensureUser } from './start.js';

export function registerToday(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('today', async (ctx) => {
    if (ctx.from === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    await ctx.reply(messages.today(todaySummary(deps, { user, now })));
  });
}
