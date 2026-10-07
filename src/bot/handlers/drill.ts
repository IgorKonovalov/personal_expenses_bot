import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { CategoryId } from '../../db/categories.js';
import type { LedgerId } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { parsePeriod, periodKey, type Period } from '../../domain/periods.js';
import { setAnchor, type Drill, type ScreenAnchor } from '../../services/flowSessions.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  categoryExpenses,
  pickerCategories,
  type CategoryExpenses,
} from '../../services/periodCategory.js';
import { ledgerPeriodSummary, type PeriodSummary } from '../../services/periodSummary.js';
import type { HandlerDeps } from '../bot.js';
import {
  DRILL_EXPENSE,
  DRILL_LIST,
  DRILL_PICKER,
  drillExpenseData,
  drillListData,
  drillPickerData,
  summaryPageData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { PAGE_SIZE, pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { backRow, renderAnchor, requireScreen, type ScreenTap } from '../screens.js';

// The summary's drill-down (Plan 0037), three more states of the /week and /month screen in its
// anchor (ADR-0011): [По категориям] shows the period's category picker, a category its numbered
// expense list, a number that expense's card (ADR-0040). The state is the screen's `drill`, and
// every tap reads the screen's ledger through the same membership and sealed-ledger checks as the
// digest. Private chats only: the group report has no anchor.

// Number buttons per row under a list.
const NUMBERS_PER_ROW = 4;

function kindOf(letter: string | undefined): Period['kind'] {
  return letter === 'm' ? 'month' : 'week';
}

// The prologue of a drill-down tap: the anchor, showing a summary. Otherwise staleScreen.
async function requireSummary(ctx: Context, deps: HandlerDeps) {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  if (screen.name !== 'summary') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, screen };
}

function recordDrill(deps: HandlerDeps, tap: ScreenTap, ledgerId: LedgerId, drill: Drill): void {
  setAnchor(deps, tap.user, { ...tap.anchor, screen: { name: 'summary', ledgerId, drill } });
}

async function showPicker(
  ctx: Context,
  deps: HandlerDeps,
  tap: ScreenTap,
  summary: PeriodSummary,
  requested: number,
): Promise<void> {
  const { period } = summary;
  const shown = pageOf(pickerCategories(summary), requested);
  const choices = shown.items.map((category) =>
    InlineKeyboard.text(
      messages.drillCategoryButton(category.name),
      drillListData(period, category.id, 1),
    ),
  );
  await renderAnchor(ctx, tap.anchor, {
    text: messages.drillPicker(summary),
    markup: pickerKeyboard(
      choices,
      pagerRow(shown, (page) => drillPickerData(period, page)),
      summaryPageData(period),
    ),
  });
  recordDrill(deps, tap, summary.ledger.id, {
    level: 'picker',
    period: { kind: period.kind, key: periodKey(period) },
    page: shown.page,
  });
}

// A page of the category's list into the anchor, and the anchor's drill set to it. A page past
// the end shows the last one. [« Назад] opens the picker page holding the category.
export async function showList(
  ctx: Context,
  deps: HandlerDeps,
  target: { readonly user: User; readonly anchor: ScreenAnchor },
  listing: CategoryExpenses,
  requested: number,
): Promise<void> {
  const { period, category } = listing;
  const pickerPage =
    listing.pickerIndex === undefined ? 1 : Math.floor(listing.pickerIndex / PAGE_SIZE) + 1;
  const back = backRow(drillPickerData(period, pickerPage));
  const shown = pageOf(listing.expenses, requested);
  const view = { ledger: listing.ledger, period, categoryName: category.name };
  if (listing.expenses.length === 0) {
    await renderAnchor(ctx, target.anchor, {
      text: messages.drillListEmpty(view),
      markup: InlineKeyboard.from([back]),
    });
  } else {
    const first = (shown.page - 1) * PAGE_SIZE + 1;
    const numbers = shown.items.map((expense, index) =>
      InlineKeyboard.text(messages.drillNumberButton(first + index), drillExpenseData(expense.id)),
    );
    const rows: InlineKeyboardButton[][] = [];
    for (let i = 0; i < numbers.length; i += NUMBERS_PER_ROW) {
      rows.push(numbers.slice(i, i + NUMBERS_PER_ROW));
    }
    const pager = pagerRow(shown, (page) => drillListData(period, category.id, page));
    if (pager.length > 0) rows.push(pager);
    rows.push(back);
    await renderAnchor(ctx, target.anchor, {
      text: messages.drillList({
        ...view,
        totals: listing.blocks.map((b) => ({ currency: b.currency, amountMinor: b.totalMinor })),
        convertedFrom: listing.convertedFrom,
        count: listing.expenses.length,
        lines: shown.items.map((expense, index) => ({ ...expense, n: first + index })),
      }),
      markup: InlineKeyboard.from(rows),
    });
  }
  recordDrill(deps, target, listing.ledger.id, {
    level: 'list',
    period: { kind: period.kind, key: periodKey(period) },
    categoryId: category.id,
    page: shown.page,
  });
}

export function registerDrill(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(DRILL_PICKER, async (ctx) => {
    const tap = await requireSummary(ctx, deps);
    if (tap === undefined) return;
    const period = parsePeriod(kindOf(ctx.match[1]), ctx.match[2] ?? '');
    const summary =
      period === undefined
        ? undefined
        : ledgerPeriodSummary(deps, {
            user: tap.user,
            ledgerId: tap.screen.ledgerId,
            period,
            now: deps.now(),
          });
    if (isLocked(summary)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    // A forged or future period, or a ledger the user left, is answered silently and edits
    // nothing.
    await ctx.answerCallbackQuery();
    if (summary !== undefined) await showPicker(ctx, deps, tap, summary, Number(ctx.match[3]));
  });

  bot.callbackQuery(DRILL_LIST, async (ctx) => {
    const tap = await requireSummary(ctx, deps);
    if (tap === undefined) return;
    const period = parsePeriod(kindOf(ctx.match[1]), ctx.match[2] ?? '');
    const categoryId = ctx.match[3] === 'n' ? null : (Number(ctx.match[3]) as CategoryId);
    const listing =
      period === undefined
        ? undefined
        : categoryExpenses(deps, {
            user: tap.user,
            ledgerId: tap.screen.ledgerId,
            period,
            categoryId,
            now: deps.now(),
          });
    if (isLocked(listing)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    // A forged or future period, a category the ledger doesn't have, or a ledger the user left,
    // is answered silently and edits nothing.
    await ctx.answerCallbackQuery();
    if (listing !== undefined) await showList(ctx, deps, tap, listing, Number(ctx.match[4]));
  });

  bot.callbackQuery(DRILL_EXPENSE, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
