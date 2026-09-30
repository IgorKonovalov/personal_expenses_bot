import type { Composer, Context } from 'grammy';
import type { User } from '../../db/users.js';
import { provisionUser } from '../../services/provisionUser.js';
import { userSettings } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import { menuKeyboard } from '../keyboards.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

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
    const { timezone, ledger } = userSettings(deps, ensureUser(deps, ctx.from.id, deps.now()));
    await replyHtml(ctx, messages.welcome({ timezone, currency: ledger.defaultCurrency }), {
      reply_markup: menuKeyboard(),
    });
  });
}
