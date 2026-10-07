import type { Composer, Context } from 'grammy';
import { clearUnreachable, markUnreachable } from '../../db/users.js';
import type { HandlerDeps } from '../bot.js';

// Whether the bot can write to a user's private chat (ADR-0043). The user blocking the bot
// arrives as a private `my_chat_member` update to `kicked`, which marks them unreachable;
// unblocking arrives as `member`, which clears it, and so does any other private update from
// them. Scheduled pushes and reminders skip an unreachable user. Registered first in the
// private composer, before the access check: it reads only the sender's own id, and the admin's
// block (`blocked_at`) is a separate column it never touches.
export function registerReachability(dm: Composer<Context>, deps: HandlerDeps): void {
  dm.use(async (ctx, next) => {
    const member = ctx.myChatMember;
    if (member !== undefined) {
      if (member.chat.type !== 'private') return;
      const status = member.new_chat_member.status;
      if (status === 'kicked' && markUnreachable(deps.db, member.from.id, deps.now())) {
        deps.logger.info({ updateId: ctx.update.update_id }, 'user blocked the bot');
      } else if (status === 'member' && clearUnreachable(deps.db, member.from.id)) {
        deps.logger.info({ updateId: ctx.update.update_id }, 'user unblocked the bot');
      }
      return;
    }
    if (ctx.chat?.type === 'private' && ctx.from !== undefined) {
      clearUnreachable(deps.db, ctx.from.id);
    }
    await next();
  });
}
