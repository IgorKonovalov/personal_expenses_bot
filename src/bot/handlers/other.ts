import type { Composer, Context } from 'grammy';
import { seenNotice } from '../../services/notices.js';
import { findExpenseForSource } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { sendStrayReply } from './help.js';
import { ensureUser } from './start.js';

// A slash command no handler claimed. Register after every command and before the text handler.
export function registerUnknownCommand(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.on('message:text', async (ctx, next) => {
    const startsWithCommand = (ctx.message.entities ?? []).some(
      (entity) => entity.type === 'bot_command' && entity.offset === 0,
    );
    if (!startsWithCommand) {
      await next();
      return;
    }
    await sendStrayReply(ctx, deps);
  });
}

// Photos, stickers, voice and any other non-text message. Register after the text handler.
export function registerNonText(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.on('message', (ctx) => sendStrayReply(ctx, deps));
}

// Editing a sent message never edits the expense. The hint goes only to edits of a message that
// recorded an expense, and only the first time (ADR-0037); the lookup is by source key, and
// nothing about the message is written or logged.
export function registerEdited(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.on('edited_message', async (ctx) => {
    const { chat, message_id } = ctx.editedMessage;
    const expense = findExpenseForSource(deps, `tg:${chat.id}:${message_id}`);
    if (expense === undefined) return;
    const now = deps.now();
    if (!seenNotice(deps, ensureUser(deps, ctx.from.id, now), 'edit_hint', now)) return;
    await replyHtml(ctx, messages.editedMessageHint);
  });
}
