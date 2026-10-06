import type { Composer, Context } from 'grammy';
import { setBlocked, usageStats } from '../../services/admission.js';
import type { AdminDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// The admin's /block, /unblock and /stats (ADR-0024). From anyone else each falls through to
// the unknown-command reply. The logs carry update ids only.

const TELEGRAM_ID = /^[1-9]\d{0,15}$/;

export function registerAdmin(bot: Composer<Context>, deps: AdminDeps): void {
  for (const command of ['block', 'unblock'] as const) {
    bot.command(command, async (ctx, next) => {
      if (ctx.from?.id !== deps.adminTelegramId) {
        await next();
        return;
      }
      const arg = ctx.match.trim();
      const telegramId = Number(arg);
      if (!TELEGRAM_ID.test(arg) || !Number.isSafeInteger(telegramId)) {
        await replyHtml(ctx, messages.blockUsage);
        return;
      }
      const blocked = command === 'block';
      const result = setBlocked(deps, { telegramId, blocked, now: deps.now() });
      if (result === 'changed') {
        deps.logger.info({ updateId: ctx.update.update_id }, `user ${command}ed`);
      }
      const reply =
        result === 'admin'
          ? messages.blockAdmin
          : result === 'notFound'
            ? messages.blockUserNotFound(telegramId)
            : blocked
              ? result === 'changed'
                ? messages.blocked(telegramId)
                : messages.alreadyBlocked(telegramId)
              : result === 'changed'
                ? messages.unblocked(telegramId)
                : messages.notBlocked(telegramId);
      await replyHtml(ctx, reply);
    });
  }

  bot.command('stats', async (ctx, next) => {
    if (ctx.from?.id !== deps.adminTelegramId) {
      await next();
      return;
    }
    await replyHtml(ctx, messages.stats(usageStats(deps, deps.now())));
  });
}
