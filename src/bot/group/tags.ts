import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { findLedgerForMember } from '../../db/ledgers.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { boundGroupLedger } from '../../services/periodSummary.js';
import { findTelegramUser } from '../../services/recordExpense.js';
import { clearLedgerStickyTag, setLedgerStickyTag } from '../../services/stickyTag.js';
import { groupLedgerTags, groupTagReport } from '../../services/tagSummary.js';
import { STICKY_TAG_OFF, TAG_LIST_PAGE, TAG_SHOW, tagListPageData } from '../callbackData.js';
import { editList, listView } from '../handlers/tags.js';
import { messages } from '../messages.js';
import { PAGE_SIZE } from '../nav.js';
import { editHtml, replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// /tags and /tag in a bound group (ADR-0029): the group ledger's tags, read through its binding
// so anyone in the chat sees them, and each member's own sticky tag. Stateless like the group's
// other screens: every tap reads the chat's binding again.

// The sender's membership of the bound ledger; undefined for an unbound chat or a sender who
// never recorded there.
function boundMember(deps: GroupHandlerDeps, chatId: number, telegramId: number) {
  const bound = boundGroupLedger(deps, chatId);
  const user = findTelegramUser(deps, telegramId);
  if (bound === undefined || user === undefined) return undefined;
  const ledger = findLedgerForMember(deps.db, bound.ledger.id, user.id);
  return ledger === undefined ? undefined : { ledger, user };
}

export function registerGroupTags(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.command('tags', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    const list = groupLedgerTags(deps, ctx.chat.id);
    if (list === undefined || isLocked(list)) return;
    if (list.tags.length === 0) {
      await replyHtml(ctx, messages.tagsEmpty);
      return;
    }
    const view = listView(list, 1);
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
  });

  group.command('tag', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    const member = boundMember(deps, ctx.chat.id, ctx.from.id);
    if (member === undefined) {
      await replyHtml(ctx, messages.groupStickyTagNotMember);
      return;
    }
    const name = setLedgerStickyTag(deps, {
      ledgerId: member.ledger.id,
      userId: member.user.id,
      text: ctx.match,
    });
    if (name === undefined) {
      await replyHtml(ctx, messages.stickyTagUsage);
      return;
    }
    await replyHtml(ctx, messages.stickyTagOn({ ledger: member.ledger, name }), {
      reply_markup: new InlineKeyboard().text(messages.stickyTagOffButton, STICKY_TAG_OFF),
    });
  });

  // Clears the tapper's own sticky tag: a tap on another member's message clears nothing of
  // theirs.
  group.callbackQuery(STICKY_TAG_OFF, async (ctx) => {
    const chatId = ctx.chat?.id;
    const member = chatId === undefined ? undefined : boundMember(deps, chatId, ctx.from.id);
    await ctx.answerCallbackQuery();
    if (member === undefined) return;
    clearLedgerStickyTag(deps, member.ledger.id, member.user.id);
    await editHtml(ctx, messages.stickyTagOff);
  });

  group.callbackQuery(TAG_LIST_PAGE, async (ctx) => {
    const list = ctx.chat === undefined ? undefined : groupLedgerTags(deps, ctx.chat.id);
    await ctx.answerCallbackQuery();
    if (list === undefined || isLocked(list)) return;
    await editList(ctx, list, Number(ctx.match[1]));
  });

  group.callbackQuery(TAG_SHOW, async (ctx) => {
    const result =
      ctx.chat === undefined
        ? undefined
        : groupTagReport(deps, {
            chatId: ctx.chat.id,
            hash: ctx.match[1] ?? '',
            pageSize: PAGE_SIZE,
          });
    if (result === undefined || result.kind === 'locked') {
      await ctx.answerCallbackQuery();
      return;
    }
    if (result.kind === 'gone') {
      await ctx.answerCallbackQuery({ text: messages.tagGone });
      await editList(ctx, result.list, 1);
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.tagReport(result), {
      reply_markup: new InlineKeyboard().text(messages.backButton, tagListPageData(result.page)),
    });
  });
}
