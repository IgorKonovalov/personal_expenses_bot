import type { Composer, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { parseExpenseText } from '../../domain/expenseText.js';
import { isAdmitted } from '../../services/admission.js';
import { boundLedger, recordGroupExpense } from '../../services/groupChats.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { reacted, replyGroupCard } from './card.js';
import type { GroupHandlerDeps } from './index.js';

// A group message that parses as an expense is recorded in the bound ledger under its sender.
// Everything else is chatter: no reply, nothing stored. Messages sent on behalf of a chat
// (anonymous admins, linked channels) and from bots never record.

export function fromPerson(message: Message): boolean {
  return message.sender_chat === undefined && message.from?.is_bot === false;
}

export function startsWithCommand(message: Message): boolean {
  return (message.entities ?? []).some(
    (entity) => entity.type === 'bot_command' && entity.offset === 0,
  );
}

export function registerGroupText(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.on('message:text', async (ctx) => {
    const message = ctx.message;
    if (!fromPerson(message) || startsWithCommand(message)) return;
    const now = deps.now();
    const result = recordGroupExpense(deps, {
      chatId: ctx.chat.id,
      sender: { telegramId: ctx.from.id, firstName: ctx.from.first_name },
      text: message.text,
      sourceKey: `tg:${ctx.chat.id}:${message.message_id}`,
      // Telegram dates are Unix seconds.
      occurredAt: new Date(message.date * 1000),
      now,
    });
    // A `/N` split records nothing in a bound group: the group splits every expense itself.
    if (result.kind === 'ignored') {
      const parsed = parseExpenseText(message.text, deps.defaultCurrency);
      if ('split' in parsed && boundLedger(deps, ctx.chat.id) !== undefined) {
        await replyHtml(ctx, messages.splitInGroup, {
          reply_parameters: { message_id: message.message_id },
        });
      }
      return;
    }
    // A redelivered message was confirmed the first time.
    if (result.duplicate) return;
    // A recognised category is confirmed by a reaction alone; «Другое», or a chat that refuses
    // reactions, gets the card.
    if (!result.fallbackCategory && (await reacted(ctx, message.message_id))) return;
    await replyGroupCard(deps, ctx, {
      expense: result.expense,
      author: ctx.from.first_name,
      authorAdmitted: isAdmitted(deps, ctx.from.id),
      ledger: result.ledger,
      replyTo: message.message_id,
    });
  });
}
