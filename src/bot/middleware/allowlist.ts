import type { MiddlewareFn } from 'grammy';
import type { Logger } from '../../logger.js';

// Drops every non-group update whose sender is not allowlisted. Nothing downstream runs, nothing
// is replied. Group updates never reach it: a group is gated by who added the bot (ADR-0014).
export function allowlist(allowedIds: ReadonlySet<number>, logger: Logger): MiddlewareFn {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined || !allowedIds.has(fromId)) {
      logger.info({ updateId: ctx.update.update_id }, 'update from non-allowlisted sender dropped');
      return;
    }
    await next();
  };
}
