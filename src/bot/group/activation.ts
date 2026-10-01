import type { Composer, Context } from 'grammy';
import type { ChatMember } from 'grammy/types';
import { bindGroup, migrateGroup, unbindGroup } from '../../services/groupChats.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';

// The bot's own membership in a group changing (`my_chat_member`). Added by an allowlisted user,
// it binds the group to a new shared ledger, or reactivates the one it had, and says hello;
// added by anyone else, it leaves. Removed, it deactivates the binding and keeps the ledger. A
// group upgraded to a supergroup moves its binding to the new chat id.

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
    const wasIn = isIn(update.old_chat_member);
    const nowIn = isIn(update.new_chat_member);
    if (wasIn && !nowIn) {
      unbindGroup(deps, update.chat.id);
      return;
    }
    if (wasIn || !nowIn) return;
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
    if (!result.created && !result.reactivated) return;
    const { ledger } = result;
    await replyHtml(
      ctx,
      messages.groupWelcome({
        timezone: ledger.timezone ?? deps.defaultTimezone,
        currency: ledger.defaultCurrency,
      }),
    );
  });

  // Telegram reports an upgrade in the old chat (`migrate_to_chat_id`) and in the new one
  // (`migrate_from_chat_id`); whichever arrives first moves the binding.
  group.on('message:migrate_to_chat_id', (ctx) => {
    migrateGroup(deps, { from: ctx.chat.id, to: ctx.message.migrate_to_chat_id });
  });
  group.on('message:migrate_from_chat_id', (ctx) => {
    migrateGroup(deps, { from: ctx.message.migrate_from_chat_id, to: ctx.chat.id });
  });
}
