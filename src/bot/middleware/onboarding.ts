import type { MiddlewareFn } from 'grammy';
import {
  claimOnboarding,
  firstExpenseInDefaultCurrency,
  pendingOnboarding,
  setupCheckView,
} from '../../services/onboarding.js';
import type { HandlerDeps } from '../bot.js';
import { sendSetupCheck, sendWelcome } from '../handlers/start.js';
import { messages } from '../messages.js';

// First contact through a message that isn't /start (ADR-0028). The message is handled as usual;
// then a user who is still not onboarded gets the welcome and the setup check, which opens by
// naming the default currency when the message recorded an expense in it. /start onboards inside
// its handler, so it finds nothing to do here. Callback queries and edits never onboard, and a
// redelivered update finds the user onboarded already.
export function onboarding(deps: HandlerDeps): MiddlewareFn {
  return async (ctx, next) => {
    await next();
    if (ctx.message === undefined || ctx.chat?.type !== 'private' || ctx.from === undefined) {
      return;
    }
    const user = pendingOnboarding(deps, ctx.from.id);
    if (user === undefined) return;
    const now = deps.now();
    await sendWelcome(ctx);
    // A concurrent update claimed it and sends the check itself.
    if (!claimOnboarding(deps, user, now)) return;
    await sendSetupCheck(
      ctx,
      messages.setupCheck({
        ...setupCheckView(deps, user, now),
        afterExpense: firstExpenseInDefaultCurrency(deps, user),
      }),
    );
  };
}
