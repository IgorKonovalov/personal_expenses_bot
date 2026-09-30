import type { Composer, Context } from 'grammy';
import { findExpenseBySourceKey } from '../../db/expenses.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { sendHelp } from './help.js';

// A slash command no handler claimed. Register after every command and before the text handler.
export function registerUnknownCommand(bot: Composer<Context>): void {
  bot.on('message:text', async (ctx, next) => {
    const startsWithCommand = (ctx.message.entities ?? []).some(
      (entity) => entity.type === 'bot_command' && entity.offset === 0,
    );
    if (!startsWithCommand) {
      await next();
      return;
    }
    await sendHelp(ctx);
  });
}

// Photos, stickers, voice and any other non-text message. Register after the text handler.
export function registerNonText(bot: Composer<Context>): void {
  bot.on('message', sendHelp);
}

// Editing a sent message never edits the expense. The hint goes only to edits of a message that
// recorded an expense; the lookup is by source key and nothing is written or logged.
export function registerEdited(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.on('edited_message', async (ctx) => {
    const { chat, message_id } = ctx.editedMessage;
    const expense = findExpenseBySourceKey(deps.db, `tg:${chat.id}:${message_id}`);
    if (expense === undefined) return;
    await replyHtml(ctx, messages.editedMessageHint);
  });
}
