import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { withMenuBack, type MenuOpened } from '../keyboards.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// The same entries the admin gets at boot (ADR-0013), for every allowed user.
export async function sendChangelog(ctx: Context): Promise<void> {
  // No preview card for the CHANGELOG.md link: the entries are the content.
  await replyHtml(ctx, messages.changelog(messages.versionAnnouncements), {
    link_preview_options: { is_disabled: true },
  });
}

// [Что нового] under the hub's help: the same entries, with [« Назад] to the hub.
export function changelogFromMenu(): MenuOpened {
  return {
    view: withMenuBack(
      { text: messages.changelog(messages.versionAnnouncements), markup: new InlineKeyboard() },
      true,
    ),
    noPreview: true,
  };
}

export function registerChangelog(bot: Composer<Context>): void {
  bot.command('changelog', sendChangelog);
}
