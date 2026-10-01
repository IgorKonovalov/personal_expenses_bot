import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { LedgerId } from '../../db/ledgers.js';
import { boundLedger } from '../../services/groupChats.js';
import { findTelegramUser } from '../../services/recordExpense.js';
import { ledgerSettings } from '../../services/settings.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// /settings in a bound group: the ledger's owner gets a deep link to the settings screen scoped
// to the group ledger, in the DM; anyone else a one-line refusal. Nothing is changed in the group.

// `https://t.me/<bot>?start=gs_<uuid>`: a 39-byte payload, under Telegram's 64.
export function ledgerSettingsLink(botUsername: string, ledgerId: LedgerId): string {
  return `https://t.me/${botUsername}?start=gs_${ledgerId}`;
}

export function registerGroupSettings(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.command('settings', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    const ledger = boundLedger(deps, ctx.chat.id);
    if (ledger === undefined) return;
    const user = findTelegramUser(deps, ctx.from.id);
    if (user === undefined || ledgerSettings(deps, user, ledger.id) === undefined) {
      await replyHtml(ctx, messages.groupSettingsOwnerOnly);
      return;
    }
    await replyHtml(ctx, messages.groupSettingsLink, {
      reply_markup: new InlineKeyboard().url(
        messages.groupSettingsButton,
        ledgerSettingsLink(ctx.me.username, ledger.id),
      ),
    });
  });
}
