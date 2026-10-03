import type { Context, MiddlewareFn } from 'grammy';
import { accessOf, redeemInvite } from '../../services/admission.js';
import type { AdminDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';

// The private-chat gate (ADR-0024). An admitted sender passes. A stranger's `/start <code>`
// redeems the code here, before any handler provisions anything, and a valid one continues as a
// normal /start. Any other stranger message gets the invitation reply once per Telegram id per
// process, then silence; a blocked sender gets silence from the first update. Group updates
// never reach it (ADR-0014).

// The ids already told, oldest first. A restart forgets them, so a stranger may get one more
// reply; persisting strangers' ids isn't worth it.
const INVITED_MEMORY = 10_000;

export class BoundedIdSet {
  private readonly ids = new Set<number>();

  constructor(private readonly capacity: number) {}

  // Adds the id and returns true when it was not there, dropping the oldest past capacity.
  add(id: number): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      // A Set iterates in insertion order: the first value is the oldest.
      const [oldest] = this.ids;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}

// An invite code's shape (11 base64url characters). The card and settings deep links (`e_…`,
// `gs_…`) are longer, so a stranger who opens one gets the invitation reply, not "invalid link".
const START_PAYLOAD = /^\/start(?:@\S+)?\s+([A-Za-z0-9_-]{11})\s*$/;

function startPayload(ctx: Context): string | undefined {
  const message = ctx.message;
  const isCommand = (message?.entities ?? []).some(
    (entity) => entity.type === 'bot_command' && entity.offset === 0,
  );
  if (!isCommand || message?.text === undefined) return undefined;
  return START_PAYLOAD.exec(message.text)?.[1];
}

export function access(deps: AdminDeps, capacity = INVITED_MEMORY): MiddlewareFn {
  const { logger } = deps;
  const invited = new BoundedIdSet(capacity);
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const updateId = ctx.update.update_id;
    if (fromId === undefined) {
      logger.info({ updateId }, 'update without a sender dropped');
      return;
    }
    const state = accessOf(deps, fromId);
    if (state === 'admitted') {
      await next();
      return;
    }
    if (state === 'blocked') {
      logger.info({ updateId }, 'update from a blocked sender dropped');
      return;
    }
    const code = startPayload(ctx);
    if (code !== undefined) {
      const result = redeemInvite(deps, { code, telegramId: fromId, now: deps.now() });
      if (result.kind === 'admitted') {
        logger.info({ updateId, userId: result.user.id }, 'invite redeemed');
        await next();
        return;
      }
      logger.info({ updateId }, 'invalid invite code');
      await replyHtml(ctx, messages.inviteInvalid);
      return;
    }
    logger.info({ updateId }, 'update from a stranger dropped');
    if (ctx.message !== undefined && invited.add(fromId)) {
      await replyHtml(ctx, messages.invitationOnly);
    }
  };
}
