import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { withMenuBack, type MenuOpened } from '../keyboards.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// /privacy: a short summary and the link to PRIVACY.md in the public repo.
export async function sendPrivacy(ctx: Context): Promise<void> {
  await replyHtml(ctx, messages.privacy);
}

// The hub's [Приватность]: the same text, with [« Назад] to the hub.
export function privacyFromMenu(): MenuOpened {
  return { view: withMenuBack({ text: messages.privacy, markup: new InlineKeyboard() }, true) };
}

export function registerPrivacy(bot: Composer<Context>): void {
  bot.command('privacy', sendPrivacy);
}
