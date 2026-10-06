import type { Composer, Context } from 'grammy';
import { refundDonation } from '../../services/refundDonation.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import type { AdminDeps } from './paysupport.js';

// `/refund <charge id>` and [Вернуть Stars]'s answer, from the admin only: the caller checks.
export async function sendRefund(ctx: Context, deps: AdminDeps, arg: string): Promise<void> {
  const chargeId = arg.trim();
  if (chargeId === '') {
    await replyHtml(ctx, messages.refundUsage);
    return;
  }
  const result = await refundDonation(
    {
      db: deps.db,
      now: deps.now,
      refundStars: async (payer, id) => {
        await ctx.api.refundStarPayment(payer, id);
      },
    },
    chargeId,
  );
  switch (result.kind) {
    case 'refunded':
      deps.logger.info({ chargeId, stars: result.stars }, 'donation refunded');
      await replyHtml(ctx, messages.refundDone(result.stars));
      return;
    case 'notFound':
      await replyHtml(ctx, messages.refundNotFound);
      return;
    case 'alreadyRefunded':
      await replyHtml(ctx, messages.refundAlreadyRefunded);
      return;
    case 'failed':
      deps.logger.warn({ chargeId }, 'donation refund failed');
      await replyHtml(ctx, messages.refundFailed(result.reason));
      return;
  }
}

// The admin's `/refund <charge id>`. Anyone else's /refund falls through to the unknown-command
// reply, so register before it.
export function registerRefund(bot: Composer<Context>, deps: AdminDeps): void {
  bot.command('refund', async (ctx, next) => {
    if (deps.adminTelegramId === undefined || ctx.from?.id !== deps.adminTelegramId) {
      await next();
      return;
    }
    await sendRefund(ctx, deps, ctx.match);
  });
}
