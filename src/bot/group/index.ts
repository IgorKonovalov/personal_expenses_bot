import { Composer, type Context } from 'grammy';
import { accessOf } from '../../services/admission.js';
import type { AdminDeps } from '../bot.js';
import { callbackDispatcher } from '../callbacks.js';
import { registerActivation } from './activation.js';
import { registerGroupCard } from './card.js';
import { registerGroupHelp } from './help.js';
import { registerGroupSettings } from './settings.js';
import { registerGroupSummary } from './summary.js';
import { registerGroupText } from './text.js';

// Every update from a group or supergroup (ADR-0014). Group interaction is stateless: no
// ADR-0009 flow, ADR-0011 anchor, menu keyboard or help fallback is reachable from here, and an
// update no group handler claims ends here silently.

// Who may bind a group by adding the bot is `isAdmitted` (ADR-0024). Group senders themselves
// need no admission.
export type GroupHandlerDeps = AdminDeps;

export function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup';
}

export function groupComposer(deps: GroupHandlerDeps): Composer<Context> {
  const group = new Composer<Context>();
  // A blocked sender's group updates stop here, before any handler (ADR-0024). Everyone else,
  // admitted or not, goes on.
  group.use(async (ctx, next) => {
    if (ctx.from !== undefined && accessOf(deps, ctx.from.id) === 'blocked') {
      deps.logger.info(
        { updateId: ctx.update.update_id },
        'group update from a blocked sender dropped',
      );
      return;
    }
    await next();
  });
  // Answers every callback query once, silently for one no group handler claims.
  group.use(callbackDispatcher());
  registerActivation(group, deps);
  registerGroupCard(group, deps);
  registerGroupSummary(group, deps);
  registerGroupHelp(group, deps);
  registerGroupSettings(group, deps);
  registerGroupText(group, deps);
  group.use(() => undefined);
  return group;
}
