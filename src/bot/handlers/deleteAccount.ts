import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { deleteAccount } from '../../services/deleteAccount.js';
import type { HandlerDeps } from '../bot.js';
import { ACCOUNT_DELETE, ACCOUNT_KEEP } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';

// /delete_account (ADR-0024): what goes and what stays, then [Удалить всё] / [Отмена]. A second
// [Удалить всё] after the deletion comes from a Telegram id with no account, which the access
// gate answers.

// `backupDays`: how long deleted data can survive in a backup (ADR-0044).
export async function sendDeleteAccount(ctx: Context, backupDays: number): Promise<void> {
  await replyHtml(ctx, messages.deleteAccountPrompt(backupDays), {
    reply_markup: new InlineKeyboard()
      .text(messages.deleteAccountButton, ACCOUNT_DELETE)
      .text(messages.cancelButton, ACCOUNT_KEEP),
  });
}

export function registerDeleteAccount(
  bot: Composer<Context>,
  deps: HandlerDeps & { readonly backupKeep: number },
): void {
  bot.command('delete_account', (ctx) => sendDeleteAccount(ctx, deps.backupKeep));

  bot.callbackQuery(ACCOUNT_DELETE, async (ctx) => {
    const result = deleteAccount(deps, { telegramId: ctx.from.id, now: deps.now() });
    if (result === 'alreadyDeleted') {
      await ctx.answerCallbackQuery({ text: messages.accountAlreadyDeleted });
      return;
    }
    await ctx.answerCallbackQuery({ text: messages.accountDeletedToast });
    await editHtml(ctx, messages.accountDeleted);
  });

  bot.callbackQuery(ACCOUNT_KEEP, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.accountKept);
  });
}
