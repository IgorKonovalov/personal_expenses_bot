import type { Composer, Context } from 'grammy';
import { boundLedger } from '../../services/groupChats.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// /help in a bound group: the group's own help text, never the DM menu keyboard.
export function registerGroupHelp(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.command('help', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    if (boundLedger(deps, ctx.chat.id) === undefined) return;
    await replyHtml(ctx, messages.groupHelp);
  });
}
