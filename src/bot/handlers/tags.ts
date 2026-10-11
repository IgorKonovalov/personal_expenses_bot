import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { encodeChartPayload } from '../../domain/chartPayload.js';
import { tagHash, type TagReport } from '../../domain/tags.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { clearStickyTag, currentStickyTag, setStickyTag } from '../../services/stickyTag.js';
import {
  activeLedgerTagReport,
  activeLedgerTags,
  type TagList,
} from '../../services/tagSummary.js';
import type { HandlerDeps } from '../bot.js';
import type { User } from '../../db/users.js';
import {
  STICKY_TAG_ASK,
  STICKY_TAG_OFF,
  TAG_LIST_PAGE,
  TAG_SHOW,
  tagListPageData,
  tagShowData,
} from '../callbackData.js';
import { withMenuBack, type MenuOpened } from '../keyboards.js';
import { messages } from '../messages.js';
import { PAGE_SIZE, pageOf, pagerRow } from '../nav.js';
import { editHtml, joinHtml, replyHtml, type Html } from '../render/html.js';
import { ensureUser } from './start.js';

// /tags (ADR-0029): the active ledger's tags with their all-time totals, PAGE_SIZE to a page,
// each a button to its report. /tag sets the sticky tag. Every tap is stateless: it reads the
// viewer's active ledger again. A report's «📈 Диаграмма» opens its converted block as a pie.

interface View {
  readonly text: Html;
  readonly markup: InlineKeyboard;
}

// The page's tags two per row, then the pager when there is one. `fromMenu` marks their data so
// the screen keeps its [« Назад] to the hub.
export function listView(list: TagList, requested: number, fromMenu = false): View {
  const shown = pageOf(list.tags, requested);
  const buttons = shown.items.map((tag) =>
    InlineKeyboard.text(messages.tagButton(tag.name), tagShowData(tagHash(tag.name), fromMenu)),
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  const pager = pagerRow(shown, (page) => tagListPageData(page, fromMenu));
  if (pager.length > 0) rows.push(pager);
  return {
    text: messages.tagList({ ledger: list.ledger, tags: shown.items }),
    markup: InlineKeyboard.from(rows),
  };
}

// The private /tags screen: the list (or tagsEmpty) with the active ledger's sticky tag under
// it, then [Постоянная метка] or, while one is on, [Снять метку], and [« Назад] to the hub when
// opened from it.
function privateView(
  deps: HandlerDeps,
  user: User,
  list: TagList,
  page: number,
  fromMenu: boolean,
): View {
  const sticky = currentStickyTag(deps, user).name;
  const base =
    list.tags.length === 0
      ? { text: messages.tagsEmpty, markup: new InlineKeyboard() }
      : listView(list, page, fromMenu);
  const stickyButton =
    sticky === undefined
      ? InlineKeyboard.text(messages.moreButtons.tag, STICKY_TAG_ASK)
      : InlineKeyboard.text(messages.stickyTagOffButton, STICKY_TAG_OFF);
  return withMenuBack(
    {
      text: joinHtml([base.text, messages.stickyTagLine(sticky)], '\n\n'),
      markup: InlineKeyboard.from([...base.markup.inline_keyboard, [stickyButton]]),
    },
    fromMenu,
  );
}

// The view a /tags tap shows: the locked message while a sealed ledger is locked.
function tagsView(deps: HandlerDeps, user: User, fromMenu: boolean): View {
  const list = activeLedgerTags(deps, user);
  if (isLocked(list)) {
    return withMenuBack({ text: messages.ledgerLocked, markup: new InlineKeyboard() }, fromMenu);
  }
  return privateView(deps, user, list, 1, fromMenu);
}

// The hub's [Метки]: page 1, as /tags shows it, with the hub mark in its callback data.
export function tagsFromMenu(deps: HandlerDeps, user: User): MenuOpened {
  return { view: tagsView(deps, user, true) };
}

// The list, or tagsEmpty once no tag is left, edited into the tapped message.
export async function editList(ctx: Context, list: TagList, page: number): Promise<void> {
  if (list.tags.length === 0) {
    await editHtml(ctx, messages.tagsEmpty);
    return;
  }
  const view = listView(list, page);
  await editHtml(ctx, view.text, { reply_markup: view.markup });
}

// /tags: the first page of the active ledger's tags.
export async function sendTags(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const view = tagsView(deps, user, false);
  // The locked message carries no keyboard.
  const empty = view.markup.inline_keyboard.length === 0;
  await replyHtml(ctx, view.text, empty ? {} : { reply_markup: view.markup });
}

// `/tag отпуск` and [Постоянная метка]'s answer set the sticky tag of the active ledger; `/tag`
// alone shows it.
export async function sendTag(ctx: Context, deps: HandlerDeps, arg: string): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const offKeyboard = new InlineKeyboard().text(messages.stickyTagOffButton, STICKY_TAG_OFF);
  if (arg.trim() === '') {
    const current = currentStickyTag(deps, user);
    if (current.name === undefined) {
      await replyHtml(ctx, messages.stickyTagNone);
      return;
    }
    await replyHtml(
      ctx,
      messages.stickyTagCurrent({ ledger: current.ledger, name: current.name }),
      {
        reply_markup: offKeyboard,
      },
    );
    return;
  }
  const result = setStickyTag(deps, user, arg);
  if (result.kind === 'invalid') {
    await replyHtml(ctx, messages.stickyTagUsage);
    return;
  }
  await replyHtml(
    ctx,
    result.sealed ? messages.stickyTagOnSealed(result) : messages.stickyTagOn(result),
    { reply_markup: offKeyboard },
  );
}

// The chart button's URL: WEBAPP_URL with the tag's pie in the fragment's `z` (ADR-0025,
// ADR-0045). Undefined outside a private chat (`web_app` buttons work only there), without
// WEBAPP_URL, when nothing converted (no pie, as with an empty period), and when the payload can't
// fit its budget. A locked sealed ledger never gets here: its tap is the locked toast.
function chartUrlOf(ctx: Context, deps: HandlerDeps, report: TagReport): string | undefined {
  if (ctx.chat?.type !== 'private' || deps.webappUrl === undefined) return undefined;
  const { converted } = report;
  if (converted === undefined) return undefined;
  const payload = encodeChartPayload(
    messages.tagChart({ ...report, converted }),
    messages.chartFold(converted.currency),
  );
  return payload === undefined ? undefined : `${deps.webappUrl}#z=${payload}`;
}

export function registerTags(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('tags', (ctx) => sendTags(ctx, deps));

  bot.command('tag', (ctx) => sendTag(ctx, deps, ctx.match));

  bot.callbackQuery(STICKY_TAG_OFF, async (ctx) => {
    const user = ensureUser(deps, ctx.from.id, deps.now());
    clearStickyTag(deps, user);
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.stickyTagOff);
  });

  // The private list, edited into the tapped message.
  const editPrivate = async (
    ctx: Context,
    user: User,
    list: TagList,
    page: number,
    fromMenu: boolean,
  ) => {
    const view = privateView(deps, user, list, page, fromMenu);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  };

  bot.callbackQuery(TAG_LIST_PAGE, async (ctx) => {
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const list = activeLedgerTags(deps, user);
    if (isLocked(list)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await editPrivate(ctx, user, list, Number(ctx.match[1]), ctx.match[2] !== undefined);
  });

  bot.callbackQuery(TAG_SHOW, async (ctx) => {
    const fromMenu = ctx.match[2] !== undefined;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = activeLedgerTagReport(deps, {
      user,
      hash: ctx.match[1] ?? '',
      pageSize: PAGE_SIZE,
    });
    switch (result.kind) {
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      case 'gone':
        await ctx.answerCallbackQuery({ text: messages.tagGone });
        await editPrivate(ctx, user, result.list, 1, fromMenu);
        return;
      case 'report': {
        await ctx.answerCallbackQuery();
        const chartUrl = chartUrlOf(ctx, deps, result.report);
        await editHtml(ctx, messages.tagReport(result), {
          reply_markup: InlineKeyboard.from([
            ...(chartUrl === undefined
              ? []
              : [[InlineKeyboard.webApp(messages.chartButton, chartUrl)]]),
            [InlineKeyboard.text(messages.backButton, tagListPageData(result.page, fromMenu))],
          ]),
        });
        return;
      }
    }
  });
}
