import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../../db/users.js';
import { addDays } from '../../domain/dateText.js';
import { parseLocalDate } from '../../domain/time.js';
import { activeDayExpenses, type DayExpenses } from '../../services/dayExpenses.js';
import { setAnchor, type ScreenAnchor } from '../../services/flowSessions.js';
import { isLocked } from '../../services/ledgerKeys.js';
import type { HandlerDeps } from '../bot.js';
import { DAY_LIST, TODAY_SHOW, dayListData, drillExpenseData } from '../callbackData.js';
import { messages } from '../messages.js';
import { PAGE_SIZE, pageOf, pagerRow } from '../nav.js';
import { backRow, renderAnchor } from '../screens.js';
import { tappedMessage } from './card.js';
import { ensureUser } from './start.js';

// /today's [Траты] (Plan 0048): a day's expenses as a numbered list in the anchor (ADR-0011),
// stepped back and forth by day. A number opens that expense's card in place through the
// drill-down's `drl:e`, and its [« Назад] comes back here (drill.ts). Private chats only.

// Number buttons per row under the list.
const NUMBERS_PER_ROW = 4;

// A page of the day's list into the anchor, and the anchor's screen set to it. A page past the end
// shows the last one. The day row steps to the day before and, short of the ledger's today, the
// day after; [« Назад] turns the message back into today's /today.
export async function showDay(
  ctx: Context,
  deps: HandlerDeps,
  target: { readonly user: User; readonly anchor: ScreenAnchor },
  listing: DayExpenses,
  requested: number,
): Promise<void> {
  const { date } = listing;
  const shown = pageOf(listing.expenses, requested);
  const rows: InlineKeyboardButton[][] = [];
  const first = (shown.page - 1) * PAGE_SIZE + 1;
  const numbers = shown.items.map((expense, index) =>
    InlineKeyboard.text(messages.drillNumberButton(first + index), drillExpenseData(expense.id)),
  );
  for (let i = 0; i < numbers.length; i += NUMBERS_PER_ROW) {
    rows.push(numbers.slice(i, i + NUMBERS_PER_ROW));
  }
  const pager = pagerRow(shown, (page) => dayListData(date, page));
  if (pager.length > 0) rows.push(pager);
  const before = addDays(date, -1);
  const after = addDays(date, 1);
  rows.push([
    InlineKeyboard.text(messages.dayPrevButton(before), dayListData(before, 1)),
    ...(date < listing.today
      ? [InlineKeyboard.text(messages.dayNextButton(after), dayListData(after, 1))]
      : []),
  ]);
  rows.push(backRow(TODAY_SHOW));
  await renderAnchor(ctx, target.anchor, {
    text:
      listing.expenses.length === 0
        ? messages.dayListEmpty(date)
        : messages.dayList({
            ledger: listing.ledger,
            date,
            totals: listing.totals,
            convertedFrom: listing.convertedFrom,
            count: listing.expenses.length,
            lines: shown.items.map((expense, index) => ({ ...expense, n: first + index })),
          }),
    markup: InlineKeyboard.from(rows),
  });
  setAnchor(deps, target.user, {
    ...target.anchor,
    screen: { name: 'day', ledgerId: listing.ledger.id, date, page: shown.page },
  });
}

export function registerDay(bot: Composer<Context>, deps: HandlerDeps): void {
  // On any message carrying it, however old: it reads the active ledger at tap time and adopts
  // the tapped message as the anchor.
  bot.callbackQuery(DAY_LIST, async (ctx) => {
    const at = tappedMessage(ctx);
    const date = parseLocalDate(ctx.match[1] ?? '');
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const listing = date === undefined ? undefined : activeDayExpenses(deps, { user, date, now });
    if (isLocked(listing)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    // A malformed or future date is answered silently and edits nothing.
    await ctx.answerCallbackQuery();
    if (listing === undefined || at === undefined) return;
    const anchor: ScreenAnchor = {
      ...at,
      screen: { name: 'day', ledgerId: listing.ledger.id, date: listing.date, page: 1 },
    };
    await showDay(ctx, deps, { user, anchor }, listing, Number(ctx.match[2]));
  });
}
