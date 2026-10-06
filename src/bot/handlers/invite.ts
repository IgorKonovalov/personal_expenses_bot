import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { localDateOf } from '../../domain/time.js';
import {
  createInvite,
  INVITE_DEFAULTS,
  INVITE_LIMITS,
  liveInvites,
  revokeInvite,
} from '../../services/admission.js';
import { resolveUserTimezone } from '../../services/settings.js';
import type { AdminDeps } from '../bot.js';
import { INVITE_REVOKE, inviteRevokeData } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import { ensureUser } from './start.js';

// The admin's invite links (ADR-0024). From anyone else the commands fall through to the
// unknown-command reply, so their existence isn't advertised.

// `/invite` takes the defaults; `/invite <uses> <days>` sets both. Anything else is undefined.
export function parseInviteArgs(text: string): { maxUses: number; days: number } | undefined {
  const args = text.trim() === '' ? [] : text.trim().split(/\s+/);
  if (args.length === 0) return { ...INVITE_DEFAULTS };
  if (args.length !== 2) return undefined;
  const maxUses = limitArg(args[0]);
  const days = limitArg(args[1]);
  return maxUses === undefined || days === undefined ? undefined : { maxUses, days };
}

function limitArg(arg: string | undefined): number | undefined {
  if (arg === undefined || !/^\d{1,4}$/.test(arg)) return undefined;
  const n = Number(arg);
  return n >= INVITE_LIMITS.min && n <= INVITE_LIMITS.max ? n : undefined;
}

// The deep link a code is handed out as: the payload is the bare code.
export function inviteLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}

// The live codes with an [Отключить] each, expiry dates in the admin's timezone.
function inviteListView(deps: AdminDeps, telegramId: number) {
  const now = deps.now();
  const timezone = resolveUserTimezone(deps, ensureUser(deps, telegramId, now));
  const codes = liveInvites(deps, now);
  const markup = InlineKeyboard.from(
    codes.map(({ code }) => [
      InlineKeyboard.text(messages.inviteRevokeButton(code), inviteRevokeData(code)),
    ]),
  );
  const text = messages.inviteList(
    codes.map((c) => ({
      code: c.code,
      used: c.used,
      maxUses: c.maxUses,
      expiresOn: localDateOf(c.expiresAt, timezone),
    })),
  );
  return { text, markup };
}

// `/invite [<uses> <days>]` and [Пригласить], from the admin only: the caller checks.
export async function sendInvite(ctx: Context, deps: AdminDeps, arg: string): Promise<void> {
  const args = parseInviteArgs(arg);
  if (args === undefined) {
    await replyHtml(ctx, messages.inviteUsage);
    return;
  }
  const invite = createInvite(deps, { ...args, now: deps.now() });
  deps.logger.info({ updateId: ctx.update.update_id }, 'invite code created');
  await replyHtml(
    ctx,
    messages.inviteCreated({ link: inviteLink(ctx.me.username, invite.code), ...args }),
  );
}

// /invites and [Приглашения], from the admin only: the caller checks.
export async function sendInvites(ctx: Context, deps: AdminDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const view = inviteListView(deps, ctx.from.id);
  await replyHtml(ctx, view.text, { reply_markup: view.markup });
}

export function registerInvite(bot: Composer<Context>, deps: AdminDeps): void {
  bot.command('invite', async (ctx, next) => {
    if (ctx.from?.id !== deps.adminTelegramId) {
      await next();
      return;
    }
    await sendInvite(ctx, deps, ctx.match);
  });

  bot.command('invites', async (ctx, next) => {
    if (ctx.from?.id !== deps.adminTelegramId) {
      await next();
      return;
    }
    await sendInvites(ctx, deps);
  });

  bot.callbackQuery(INVITE_REVOKE, async (ctx, next) => {
    const code = ctx.match[1];
    if (ctx.from.id !== deps.adminTelegramId || code === undefined) {
      await next();
      return;
    }
    const result = revokeInvite(deps, { code, now: deps.now() });
    switch (result) {
      case 'revoked': {
        deps.logger.info({ updateId: ctx.update.update_id }, 'invite code revoked');
        await ctx.answerCallbackQuery({ text: messages.inviteRevokedToast });
        const view = inviteListView(deps, ctx.from.id);
        await editHtml(ctx, view.text, { reply_markup: view.markup });
        return;
      }
      case 'alreadyRevoked':
        await ctx.answerCallbackQuery({ text: messages.inviteAlreadyRevoked });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.inviteNotFound });
        return;
    }
  });
}
