import type { Composer, Context } from 'grammy';
import { createInvite, INVITE_DEFAULTS, INVITE_LIMITS } from '../../services/admission.js';
import type { AdminDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// The admin's invite links (ADR-0024). From anyone else the command falls through to the
// unknown-command reply, so its existence isn't advertised.

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

export function registerInvite(bot: Composer<Context>, deps: AdminDeps): void {
  bot.command('invite', async (ctx, next) => {
    if (ctx.from?.id !== deps.adminTelegramId) {
      await next();
      return;
    }
    const args = parseInviteArgs(ctx.match);
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
  });
}
