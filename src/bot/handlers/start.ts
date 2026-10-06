import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { ExpenseId } from '../../db/expenses.js';
import type { LedgerId } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { showExpense } from '../../services/changeCategory.js';
import {
  claimOnboarding,
  isOnboarded,
  replayOnboarding,
  setupCheckView,
  setupView,
} from '../../services/onboarding.js';
import { provisionUser } from '../../services/provisionUser.js';
import type { HandlerDeps } from '../bot.js';
import { ONBOARDING_EDIT, ONBOARDING_OK } from '../callbackData.js';
import { menuKeyboard } from '../keyboards.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml, type Html } from '../render/html.js';
import { cardFor, cardView } from './card.js';
import { sendLedgerSettings, showSettingsInPlace } from './settings.js';

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
// An invite code, the shape the access middleware redeems before this handler runs.
const INVITE_PAYLOAD = /^[A-Za-z0-9_-]{11}$/;

// The welcome, with the menu keyboard.
export async function sendWelcome(ctx: Context): Promise<void> {
  await replyHtml(ctx, messages.welcome, { reply_markup: menuKeyboard() });
}

// The setup check, with [Да, всё верно] and [Изменить]. A message carries one keyboard, so the
// check is its own message after the welcome (ADR-0028).
export async function sendSetupCheck(ctx: Context, text: Html): Promise<void> {
  await replyHtml(ctx, text, {
    reply_markup: InlineKeyboard.from([
      [
        InlineKeyboard.text(messages.setupOkButton, ONBOARDING_OK),
        InlineKeyboard.text(messages.setupEditButton, ONBOARDING_EDIT),
      ],
    ]),
  });
}

// /start: a never-onboarded user is marked onboarded just before the setup check goes out. An
// onboarded one replays the tour, tips reset and on, only under `mayReplay`; otherwise they get
// the welcome alone.
async function sendTour(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  { mayReplay }: { mayReplay: boolean },
): Promise<void> {
  const now = deps.now();
  const onboarded = isOnboarded(deps, user);
  if (onboarded && mayReplay) replayOnboarding(deps, user);
  await sendWelcome(ctx);
  if (onboarded && !mayReplay) return;
  // A concurrent first update claimed it and sends the check itself.
  if (!onboarded && !claimOnboarding(deps, user, now)) return;
  await sendSetupCheck(ctx, messages.setupCheck(setupCheckView(deps, user, now)));
}

export function registerStart(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('start', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const expenseId = EXPENSE_PAYLOAD.exec(ctx.match)?.[1] as ExpenseId | undefined;
    if (expenseId !== undefined) {
      // The author's own expense only; anyone else falls through to the tour below.
      const shown = showExpense(deps, { user, expenseId });
      if (shown.kind === 'card' && shown.expense.createdBy === user.id) {
        const card = cardFor(cardView(deps, user, shown));
        await replyHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
    }
    const ledgerId = LEDGER_SETTINGS_PAYLOAD.exec(ctx.match)?.[1] as LedgerId | undefined;
    // The ledger's owner only; anyone else falls through to the tour below.
    if (ledgerId !== undefined && (await sendLedgerSettings(ctx, deps, user, ledgerId))) return;
    // A group card's [Изменить в личке] is open to every member, so an unresolved deep link must
    // not reset the tips: only a bare /start or an invite code replays.
    await sendTour(ctx, deps, user, {
      mayReplay: ctx.match === '' || INVITE_PAYLOAD.test(ctx.match),
    });
  });

  // [Да, всё верно]: the check becomes the confirmation, with no keyboard. A repeat edits it to
  // the same text.
  bot.callbackQuery(ONBOARDING_OK, async (ctx) => {
    const user = ensureUser(deps, ctx.from.id, deps.now());
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.setupConfirmed(setupView(deps, user)));
  });

  // [Изменить]: the check becomes the settings hub.
  bot.callbackQuery(ONBOARDING_EDIT, async (ctx) => {
    const user = ensureUser(deps, ctx.from.id, deps.now());
    await ctx.answerCallbackQuery();
    await showSettingsInPlace(ctx, deps, user);
  });
}
