import type { Composer, Context } from 'grammy';
import type { ChatMember } from 'grammy/types';
import { bindGroup } from '../../services/groupChats.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';

// The bot's own membership in a group changing (`my_chat_member`). Added by an allowlisted user,
// it binds the group to a new shared ledger and says hello once; added by anyone else, it leaves.

function isIn(member: ChatMember): boolean {
  return (
    member.status === 'member' ||
    member.status === 'administrator' ||
    (member.status === 'restricted' && member.is_member)
  );
}

export function registerActivation(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    if (isIn(update.old_chat_member) || !isIn(update.new_chat_member)) return;
    if (!deps.allowedTelegramIds.has(update.from.id)) {
      deps.logger.info(
        { updateId: ctx.update.update_id },
        'added to a group by a non-allowlisted user',
      );
      await ctx.leaveChat();
      return;
    }
    const title = update.chat.title ?? '';
    const result = bindGroup(deps, {
      chatId: update.chat.id,
      title,
      adder: { telegramId: update.from.id, firstName: update.from.first_name },
      now: deps.now(),
    });
    if (!result.created) return;
    const { ledger } = result;
    await replyHtml(
      ctx,
      messages.groupWelcome({
        timezone: ledger.timezone ?? deps.defaultTimezone,
        currency: ledger.defaultCurrency,
      }),
    );
  });
}
