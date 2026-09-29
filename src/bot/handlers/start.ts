import type { Composer, Context } from 'grammy';
import type { User } from '../../db/users.js';
import { provisionUser } from '../../services/provisionUser.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';

// The internal user behind a Telegram account, provisioned on first contact. Every handler
// resolves its user this way, so a message sent before /start still has a ledger.
export function ensureUser(deps: HandlerDeps, telegramUserId: number, now: Date): User {
  return provisionUser(deps, {
    provider: 'telegram',
    externalId: String(telegramUserId),
    defaultTimezone: deps.defaultTimezone,
    defaultCurrency: deps.defaultCurrency,
    now,
  }).user;
}

export function registerStart(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('start', async (ctx) => {
    if (ctx.from === undefined) return;
    ensureUser(deps, ctx.from.id, deps.now());
    await ctx.reply(messages.welcome);
  });
}
