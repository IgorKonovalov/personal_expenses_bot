import type { Composer, Context } from 'grammy';
import { listDonationsOfUser } from '../../db/donations.js';
import { findUserByIdentity } from '../../db/users.js';
import { localDateOf } from '../../domain/time.js';
import { resolveUserTimezone } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml, type Html } from '../render/html.js';
import { ensureUser } from './start.js';

export interface AdminDeps extends HandlerDeps {
  // Undefined: no admin, so nothing reaches one.
  readonly adminTelegramId: number | undefined;
  readonly notifyAdmin: (body: Html) => Promise<void>;
}

// The admin's request lists at most this many donations, newest first.
const SHOWN_DONATIONS = 10;

// The zone the admin reads dates in: their own once they have a user, else the default.
function adminTimezone(deps: AdminDeps): string {
  const admin =
    deps.adminTelegramId === undefined
      ? undefined
      : findUserByIdentity(deps.db, 'telegram', String(deps.adminTelegramId));
  return admin === undefined ? deps.defaultTimezone : resolveUserTimezone(deps, admin);
}

// /paysupport alone explains; `/paysupport <text>` relays the text to the admin with the user's
// internal id and donations, then confirms.
export function registerPaySupport(bot: Composer<Context>, deps: AdminDeps): void {
  bot.command('paysupport', async (ctx) => {
    if (ctx.from === undefined) return;
    const text = ctx.match.trim();
    if (text === '') {
      await replyHtml(ctx, messages.paySupport);
      return;
    }
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const timezone = adminTimezone(deps);
    const donations = listDonationsOfUser(deps.db, user.id, SHOWN_DONATIONS).map((d) => ({
      chargeId: d.chargeId,
      stars: d.stars,
      on: localDateOf(d.createdAt, timezone),
      refunded: d.refundedAt !== null,
    }));
    await deps.notifyAdmin(messages.adminPaySupport({ userId: user.id, text, donations }));
    await replyHtml(ctx, messages.paySupportSent);
  });
}
