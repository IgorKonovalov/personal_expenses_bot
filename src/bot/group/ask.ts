import { GrammyError, InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { isAdmitted } from '../../services/admission.js';
import { answerGroupAsk, groupAskFor, saveGroupAsk } from '../../services/groupChats.js';
import { GROUP_ASK, groupAskData } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import { groupCard, reacted } from './card.js';
import type { GroupHandlerDeps } from './index.js';

// The question to an amount-last group message (ADR-0046): «Записать 3 200.00 RSD — Чайник?»,
// replied to the message without a notification, with [Записать] and [Не трата]. Only the
// message's sender answers it. The stored row is its only state, and the scheduler's
// groupAskProvider deletes one nobody answered.

// Asks about the message when it reads as an amount-last expense. True when a question was sent.
export async function askGroupExpense(
  ctx: Context,
  deps: GroupHandlerDeps,
  message: Message.TextMessage,
): Promise<boolean> {
  const chatId = message.chat.id;
  const sentAt = new Date(message.date * 1000);
  const offer = groupAskFor(deps, {
    chatId,
    messageId: message.message_id,
    text: message.text,
    occurredAt: sentAt,
  });
  if (offer === undefined || message.from === undefined) return false;
  const sent = await replyHtml(ctx, messages.groupAskRecord(offer), {
    reply_parameters: { message_id: message.message_id },
    reply_markup: new InlineKeyboard()
      .text(messages.groupAskRecordButton, groupAskData('ok', message.message_id))
      .text(messages.groupAskNotExpenseButton, groupAskData('no', message.message_id)),
    disable_notification: true,
  });
  saveGroupAsk(deps, {
    chatId,
    messageId: message.message_id,
    ledgerId: offer.ledger.id,
    senderTelegramId: message.from.id,
    text: message.text,
    sentAt,
    askMessageId: sent.message_id,
    now: deps.now(),
  });
  return true;
}

export function registerGroupAsk(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.callbackQuery(GROUP_ASK, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = Number(ctx.match[2]);
    if (chatId === undefined) return;
    const result = answerGroupAsk(deps, {
      chatId,
      messageId,
      tapper: { telegramId: ctx.from.id, firstName: ctx.from.first_name },
      answer: ctx.match[1] === 'ok' ? 'record' : 'dismiss',
      now: deps.now(),
    });
    switch (result.kind) {
      case 'recorded': {
        await ctx.answerCallbackQuery();
        const { recorded } = result;
        // As for amount-first text: a recognised category is confirmed by a reaction on the
        // message, and the question goes; «Другое», or a chat that refuses reactions, gets the
        // card in the question's place.
        if (!recorded.fallbackCategory && (await reacted(ctx, messageId))) {
          await deleteQuestion(ctx, deps);
          return;
        }
        const card = groupCard(
          deps,
          ctx,
          {
            expense: recorded.expense,
            author: ctx.from.first_name,
            authorAdmitted: isAdmitted(deps, ctx.from.id),
          },
          recorded.ledger,
        );
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'dismissed':
        await ctx.answerCallbackQuery();
        await deleteQuestion(ctx, deps);
        return;
      case 'notSender':
        await ctx.answerCallbackQuery({ text: messages.groupAskNotSender });
        return;
      case 'alreadyRecorded':
        await ctx.answerCallbackQuery({ text: messages.groupAskAlreadyRecorded });
        await removeKeyboard(ctx, deps);
        return;
      case 'gone':
        await ctx.answerCallbackQuery({ text: messages.groupAskGone });
        await removeKeyboard(ctx, deps);
        return;
    }
  });
}

// The question may be gone already, or be older than Telegram lets a bot delete: its row is,
// so a later tap answers from the expense alone.
async function deleteQuestion(ctx: Context, deps: GroupHandlerDeps): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    deps.logger.debug({ err: error.name }, 'group ask question not deleted');
  }
}

async function removeKeyboard(ctx: Context, deps: GroupHandlerDeps): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    deps.logger.debug({ err: error.name }, 'group ask keyboard not removed');
  }
}
