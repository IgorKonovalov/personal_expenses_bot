import type { Composer, Context } from 'grammy';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// The same entries the admin gets at boot (ADR-0013), for every allowed user.
export function registerChangelog(bot: Composer<Context>): void {
  bot.command('changelog', async (ctx) => {
    await replyHtml(ctx, messages.changelog(messages.versionAnnouncements));
  });
}
