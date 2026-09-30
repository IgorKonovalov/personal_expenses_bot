import type { Composer, Context } from 'grammy';
import { menuKeyboard } from '../keyboards.js';
import { messages } from '../messages.js';

// The help reply: /help, the ❓ menu button, unknown commands and anything that isn't text.
export async function sendHelp(ctx: Context): Promise<void> {
  await ctx.reply(messages.help, { reply_markup: menuKeyboard() });
}

export function registerHelp(bot: Composer<Context>): void {
  bot.command('help', sendHelp);
}
