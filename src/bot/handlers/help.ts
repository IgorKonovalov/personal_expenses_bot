import type { Composer, Context } from 'grammy';
import { seenNotice } from '../../services/notices.js';
import { isOnboarded } from '../../services/onboarding.js';
import type { HandlerDeps } from '../bot.js';
import { menuKeyboardFor } from '../keyboards.js';
import { messages } from '../messages.js';
import { replyHtml, sendTransient } from '../render/html.js';
import { ensureUser } from './start.js';

// The help reply: /help and the ❓ menu button, every time.
export async function sendHelp(ctx: Context, webappUrl: string | undefined): Promise<void> {
  await replyHtml(ctx, messages.help, { reply_markup: menuKeyboardFor(ctx, webappUrl) });
}

// Input the bot can't read (an unknown command, text that isn't an expense, a sticker): the full
// help the first time (ADR-0037), then a one-line pointer to it that deletes itself. A
// never-onboarded user gets nothing here: the welcome and setup check that follow stand in for
// it, and the welcome points to /help, so the full help counts as seen.
export async function sendStrayReply(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  if (!isOnboarded(deps, user)) {
    seenNotice(deps, user, 'stray_help', now);
    return;
  }
  if (seenNotice(deps, user, 'stray_help', now)) {
    await sendHelp(ctx, deps.webappUrl);
    return;
  }
  await sendTransient(ctx, messages.notUnderstood, (error) => {
    deps.logger.warn(
      { updateId: ctx.update.update_id, err: error instanceof Error ? error.name : typeof error },
      'transient reply delete failed',
    );
  });
}

export function registerHelp(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('help', (ctx) => sendHelp(ctx, deps.webappUrl));
}
