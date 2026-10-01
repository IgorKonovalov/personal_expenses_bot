import type { Composer, Context } from 'grammy';
import type { ExpenseId } from '../../db/expenses.js';
import type { LedgerId } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { showExpense } from '../../services/changeCategory.js';
import { provisionUser } from '../../services/provisionUser.js';
import { userSettings } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import { menuKeyboard } from '../keyboards.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { cardFor, cardView } from './card.js';
import { sendLedgerSettings } from './settings.js';

// The internal user behind a Telegram account, provisioned on first contact. Every handler
// resolves its user this way, so a message sent before /start still has a ledger.
export function ensureUser(deps: HandlerDeps, telegramUserId: number, now: Date): User {
  return provisionUser(deps, {
    provider: 'telegram',
    externalId: String(telegramUserId),
    defaultTimezone: deps.defaultTimezone,
    defaultCurrency: deps.defaultCurrency,
    now,
  }).user;
}

// The group deep links (ADR-0014): the card's [Изменить в личке] `/start e_<expense uuid>`, and
// the group /settings `/start gs_<ledger uuid>`.
const EXPENSE_PAYLOAD = /^e_([0-9a-f-]{36})$/;
const LEDGER_SETTINGS_PAYLOAD = /^gs_([0-9a-f-]{36})$/;

export function registerStart(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('start', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const expenseId = EXPENSE_PAYLOAD.exec(ctx.match)?.[1] as ExpenseId | undefined;
    if (expenseId !== undefined) {
      // The author's own expense only; any other payload gets the plain welcome.
      const shown = showExpense(deps, { user, expenseId });
      if (shown.kind === 'card' && shown.expense.createdBy === user.id) {
        const card = cardFor(cardView(deps, user, shown));
        await replyHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
    }
    const ledgerId = LEDGER_SETTINGS_PAYLOAD.exec(ctx.match)?.[1] as LedgerId | undefined;
    // The ledger's owner only; anyone else gets the plain welcome.
    if (ledgerId !== undefined && (await sendLedgerSettings(ctx, deps, user, ledgerId))) return;
    const { timezone, ledger } = userSettings(deps, user);
    await replyHtml(ctx, messages.welcome({ timezone, currency: ledger.defaultCurrency }), {
      reply_markup: menuKeyboard(),
    });
  });
}
