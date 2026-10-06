import type { Composer, Context } from 'grammy';
import { parsePeriod, type Period } from '../../domain/periods.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { ledgerPeriodItems, type PeriodItems } from '../../services/periodItems.js';
import type { HandlerDeps } from '../bot.js';
import { PERIOD_ITEMS, periodItemsData, summaryPageData } from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { renderAnchor, requireScreen, type ScreenView } from '../screens.js';

// [Позиции] (ADR-0038): a period's receipt items by category, edited in place with a pager of
// rendered pages and [« Назад] to where it was opened from. On /week and /month it is a state of
// the summary screen and reads the screen's ledger.

export function itemsView(
  items: PeriodItems,
  range: Parameters<typeof messages.periodItemPages>[0]['range'],
  requested: number,
  dataFor: (page: number) => string,
  backData: string,
): ScreenView | undefined {
  const pages = messages.periodItemPages({ ...items, range });
  // One rendered page per pager page; a page number past the end shows the last one.
  const shown = pageOf(pages, requested, 1);
  const [text] = shown.items;
  if (text === undefined) return undefined;
  return { text, markup: pickerKeyboard([], pagerRow(shown, dataFor), backData) };
}

export function registerItems(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(PERIOD_ITEMS, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const { screen } = tap.anchor;
    if (screen.name !== 'summary') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const period: Period | undefined = parsePeriod(
      ctx.match[1] === 'm' ? 'month' : 'week',
      ctx.match[2] ?? '',
    );
    const items =
      period === undefined
        ? undefined
        : ledgerPeriodItems(deps, {
            user: tap.user,
            ledgerId: screen.ledgerId,
            range: period,
            now: deps.now(),
          });
    if (isLocked(items)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    // A forged or future period is answered silently and edits nothing.
    await ctx.answerCallbackQuery();
    if (items === undefined || period === undefined) return;
    const view = itemsView(
      items,
      period,
      Number(ctx.match[3]),
      (page) => periodItemsData(period, page),
      summaryPageData(period),
    );
    if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
  });
}
