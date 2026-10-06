import type { Composer, Context } from 'grammy';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// /privacy: a short summary and the link to PRIVACY.md in the public repo.
export async function sendPrivacy(ctx: Context): Promise<void> {
  await replyHtml(ctx, messages.privacy);
}

export function registerPrivacy(bot: Composer<Context>): void {
  bot.command('privacy', sendPrivacy);
}
