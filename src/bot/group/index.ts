import { Composer, type Context } from 'grammy';
import type { HandlerDeps } from '../bot.js';
import { registerActivation } from './activation.js';
import { registerGroupText } from './text.js';

// Every update from a group or supergroup (ADR-0014). Group interaction is stateless: no
// ADR-0009 flow, ADR-0011 anchor, menu keyboard or help fallback is reachable from here, and an
// update no group handler claims ends here silently.

export interface GroupHandlerDeps extends HandlerDeps {
  // Who may bind a group by adding the bot. Group senders themselves are not checked.
  readonly allowedTelegramIds: ReadonlySet<number>;
}

export function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup';
}

export function groupComposer(deps: GroupHandlerDeps): Composer<Context> {
  const group = new Composer<Context>();
  registerActivation(group, deps);
  registerGroupText(group, deps);
  group.use(() => undefined);
  return group;
}
