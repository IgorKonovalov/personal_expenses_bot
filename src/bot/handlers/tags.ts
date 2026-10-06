import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { isLocked } from '../../services/ledgerKeys.js';
import { activeLedgerTags, type TagList } from '../../services/tagSummary.js';
import type { HandlerDeps } from '../bot.js';
import { TAG_LIST_PAGE, tagListPageData } from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow } from '../nav.js';
import { editHtml, replyHtml, type Html } from '../render/html.js';
import { ensureUser } from './start.js';

// /tags (ADR-0029): the active ledger's tags with their all-time totals, PAGE_SIZE to a page.
// The pager is stateless: a tap reads the viewer's active ledger again.

function listView(list: TagList, requested: number): { text: Html; markup: InlineKeyboard } {
  const shown = pageOf(list.tags, requested);
  const pager = pagerRow(shown, tagListPageData);
  return {
    text: messages.tagList({ ledger: list.ledger, tags: shown.items }),
    markup: InlineKeyboard.from(pager.length === 0 ? [] : [pager]),
  };
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
    if (list.tags.length === 0) {
      await editHtml(ctx, messages.tagsEmpty);
      return;
    }
    const view = listView(list, Number(ctx.match[1]));
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });
}
