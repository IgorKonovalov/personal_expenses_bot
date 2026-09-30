import type { Composer, Context } from 'grammy';
import { menuKeyboard } from '../keyboards.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// The help reply: /help, the ❓ menu button, unknown commands, text that isn't an expense, and
// anything that isn't text.
export async function sendHelp(ctx: Context): Promise<void> {
  await replyHtml(ctx, messages.help, { reply_markup: menuKeyboard() });
}

export function registerHelp(bot: Composer<Context>): void {
  bot.command('help', sendHelp);
}
