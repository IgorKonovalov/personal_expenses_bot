import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { tagHash } from '../../domain/tags.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  activeLedgerTagReport,
  activeLedgerTags,
  type TagList,
} from '../../services/tagSummary.js';
import type { HandlerDeps } from '../bot.js';
import { TAG_LIST_PAGE, TAG_SHOW, tagListPageData, tagShowData } from '../callbackData.js';
import { messages } from '../messages.js';
import { PAGE_SIZE, pageOf, pagerRow } from '../nav.js';
import { editHtml, replyHtml, type Html } from '../render/html.js';
import { ensureUser } from './start.js';

// /tags (ADR-0029): the active ledger's tags with their all-time totals, PAGE_SIZE to a page,
// each a button to its report. Every tap is stateless: it reads the viewer's active ledger again.

interface View {
  readonly text: Html;
  readonly markup: InlineKeyboard;
}

// The page's tags two per row, then the pager when there is one.
function listView(list: TagList, requested: number): View {
  const shown = pageOf(list.tags, requested);
  const buttons = shown.items.map((tag) =>
    InlineKeyboard.text(messages.tagButton(tag.name), tagShowData(tagHash(tag.name))),
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  const pager = pagerRow(shown, tagListPageData);
  if (pager.length > 0) rows.push(pager);
  return {
    text: messages.tagList({ ledger: list.ledger, tags: shown.items }),
    markup: InlineKeyboard.from(rows),
  };
}

// The list, or tagsEmpty once no tag is left, edited into the tapped message.
async function editList(ctx: Context, list: TagList, page: number): Promise<void> {
  if (list.tags.length === 0) {
    await editHtml(ctx, messages.tagsEmpty);
    return;
  }
  const view = listView(list, page);
  await editHtml(ctx, view.text, { reply_markup: view.markup });
}

export function registerTags(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('tags', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const list = activeLedgerTags(deps, user);
    if (isLocked(list)) {
      await replyHtml(ctx, messages.ledgerLocked);
      return;
    }
    if (list.tags.length === 0) {
      await replyHtml(ctx, messages.tagsEmpty);
      return;
    }
    const view = listView(list, 1);
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(TAG_LIST_PAGE, async (ctx) => {
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const list = activeLedgerTags(deps, user);
    if (isLocked(list)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await editList(ctx, list, Number(ctx.match[1]));
  });

  bot.callbackQuery(TAG_SHOW, async (ctx) => {
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
        await editList(ctx, result.list, 1);
        return;
      case 'report':
        await ctx.answerCallbackQuery();
        await editHtml(ctx, messages.tagReport(result), {
          reply_markup: new InlineKeyboard().text(
            messages.backButton,
            tagListPageData(result.page),
          ),
        });
        return;
    }
  });
}
