import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Document } from 'grammy/types';
import { isAmbiguousItem } from '../../domain/chatImport/readMessage.js';
import { readTelegramExport } from '../../domain/chatImport/telegramExport.js';
import type { FileDownloader } from '../../jobs/child.js';
import type { User } from '../../db/users.js';
import type { ChatImportFixFlow } from '../../services/flowSessions.js';
import {
  answerChatImportFix,
  answerChatImportPrefix,
  cancelChatImport,
  chatImportNotice,
  chatImportUndoCount,
  currentChatImportPreview,
  cycleChatImportPayer,
  saveChatImportNotice,
  undoChatImport,
  finishChatImportReview,
  openChatImportReview,
  pickChatImportReading,
  previewChatImport,
  recordChatImportCard,
  recordReadyChatImport,
  showChatImportCard,
  skipChatImportCard,
  startChatImportFix,
  type ChatImportCard,
  type ChatImportPreview,
  type ChatImportReviewView,
  type ReviewResult,
} from '../../services/importChat.js';
import type { HandlerDeps } from '../bot.js';
import {
  CHAT_IMPORT_CANCEL,
  CHAT_IMPORT_CARD,
  CHAT_IMPORT_FINISH,
  CHAT_IMPORT_PAGE,
  CHAT_IMPORT_PREFIX,
  CHAT_IMPORT_READING,
  CHAT_IMPORT_RECORD,
  CHAT_IMPORT_REVIEW,
  CHAT_IMPORT_UNDO,
  CHAT_IMPORT_UNDO_NO,
  CHAT_IMPORT_UNDO_YES,
  chatImportCardData,
  chatImportData,
  chatImportPageData,
  chatImportPrefixData,
  chatImportReadingData,
  type ChatImportCardAction,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow } from '../nav.js';
import { editHtml, editHtmlAt, html, replyHtml, sendHtml, type Html } from '../render/html.js';
import { ensureUser } from './start.js';

// A group's history from a Telegram Desktop JSON export, sent in DM (ADR-0047): read in memory,
// previewed against the group's ledger, recorded by a tap, and its doubtful messages reviewed one
// card at a time. A document that isn't JSON goes on to the handlers after this one. Register
// before the statement handler.

function isJson(document: Document): boolean {
  return (
    document.mime_type === 'application/json' ||
    document.file_name?.toLowerCase().endsWith('.json') === true
  );
}

interface View {
  readonly text: Html;
  readonly markup: InlineKeyboard;
}

// A file over this many bytes is refused before it is downloaded.
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
// The preview lists the ready items this many to a page.
const READY_PER_PAGE = 10;

// The question about a name prefix while one is unanswered; the preview otherwise, with page
// `page` (1-based) of the ready items.
function previewView(preview: ChatImportPreview, page = 1): View {
  const { question, nonce } = preview;
  if (question !== undefined) {
    const senders = question.senders.map((sender) =>
      InlineKeyboard.text(sender.name, chatImportPrefixData(nonce, question.index, sender.index)),
    );
    const rows = [];
    for (let i = 0; i < senders.length; i += 2) rows.push(senders.slice(i, i + 2));
    rows.push(
      [
        InlineKeyboard.text(
          messages.chatImportPrefixAuthorButton,
          chatImportPrefixData(nonce, question.index, 'a'),
        ),
        InlineKeyboard.text(
          messages.chatImportPrefixNotNameButton,
          chatImportPrefixData(nonce, question.index, 'x'),
        ),
      ],
      [InlineKeyboard.text(messages.cancelButton, chatImportData('x', nonce))],
    );
    return { text: messages.chatImportPrefixAsk(question), markup: InlineKeyboard.from(rows) };
  }
  const keyboard = new InlineKeyboard();
  if (preview.ready.length > 0) {
    keyboard
      .text(
        messages.chatImportRecordButton(preview.ready.length),
        chatImportData('rec', preview.nonce),
      )
      .row();
  }
  if (preview.reviewCount > 0) {
    keyboard
      .text(
        messages.chatImportReviewButton(preview.reviewCount),
        chatImportData('rev', preview.nonce),
      )
      .row();
  }
  if (preview.alreadyCount > 0) {
    keyboard.text(messages.chatImportUndoButton, chatImportData('undo', preview.nonce)).row();
  }
  const shown = pageOf(preview.ready, page, READY_PER_PAGE);
  const pager = pagerRow(shown, (p) => chatImportPageData(preview.nonce, p));
  if (pager.length > 0) keyboard.add(...pager).row();
  keyboard.text(messages.cancelButton, chatImportData('x', preview.nonce));
  return {
    text: messages.chatImportPreview({
      ...preview,
      readyCount: preview.ready.length,
      lines: shown.items,
    }),
    markup: keyboard,
  };
}

function cardView(card: ChatImportCard): View {
  const { nonce, index } = card;
  const rows = [];
  if (card.recordable) {
    rows.push([
      InlineKeyboard.text(
        messages.chatImportRecordCardButton,
        chatImportCardData('ok', nonce, index),
      ),
    ]);
  }
  const ambiguous = card.items.find(isAmbiguousItem);
  if (ambiguous !== undefined) {
    rows.push(
      ambiguous.readings.map((reading, r) =>
        InlineKeyboard.text(
          messages.readingButton({
            amountMinor: reading.amountMinor,
            currency: ambiguous.currency,
          }),
          chatImportReadingData(nonce, index, r),
        ),
      ),
    );
  }
  rows.push(
    [
      InlineKeyboard.text(messages.chatImportFixButton, chatImportCardData('fix', nonce, index)),
      InlineKeyboard.text(messages.chatImportSkipButton, chatImportCardData('skip', nonce, index)),
    ],
    [
      InlineKeyboard.text(
        messages.chatImportPayerButton(card.payer?.name),
        chatImportCardData('who', nonce, index),
      ),
    ],
    [InlineKeyboard.text(messages.chatImportFinishButton, chatImportData('end', nonce))],
  );
  return { text: messages.chatImportCard(card), markup: InlineKeyboard.from(rows) };
}

function reviewView(view: ChatImportReviewView): View {
  if (view.kind === 'card') return cardView(view);
  const keyboard = new InlineKeyboard();
  if (view.readyCount > 0) {
    keyboard
      .text(messages.chatImportRecordButton(view.readyCount), chatImportData('rec', view.nonce))
      .row();
  }
  keyboard.text(messages.chatImportUndoButton, chatImportData('undo', view.nonce));
  return { text: messages.chatImportReviewDone(view), markup: keyboard };
}

// Brings the group's notice up to date after a recording: posted silently the first time
// something was recorded, edited in place after. A failure is logged, never shown: the import in
// the DM stands without it.
async function syncNotice(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  nonce: string,
): Promise<void> {
  const notice = chatImportNotice(deps, { user, nonce, now: deps.now() });
  if (notice === undefined) return;
  const text = messages.chatImportNotice(notice);
  try {
    if (notice.messageId !== null) {
      await editHtmlAt(ctx, { chatId: notice.chatId, messageId: notice.messageId }, text);
      return;
    }
    if (notice.count === 0) return;
    const sent = await sendHtml(ctx.api, notice.chatId, text, { disable_notification: true });
    saveChatImportNotice(deps, { user, nonce, messageId: sent.message_id });
  } catch (error) {
    deps.logger.warn(
      { userId: user.id, error: error instanceof Error ? error.message : String(error) },
      'chat import notice failed',
    );
  }
}

// A tap on a button whose upload is gone: `stale` answers with a toast and leaves the message,
// `expired` edits it.
async function answerGone(ctx: Context, kind: 'stale' | 'expired'): Promise<void> {
  if (kind === 'stale') {
    await ctx.answerCallbackQuery({ text: messages.chatImportStale });
    return;
  }
  await ctx.answerCallbackQuery();
  await editHtml(ctx, messages.chatImportExpired);
}

// Edits the tapped message into the card or summary the tap led to.
async function showReview(ctx: Context, result: ReviewResult): Promise<void> {
  if (result.kind === 'expired' || result.kind === 'stale') {
    await answerGone(ctx, result.kind);
    return;
  }
  await ctx.answerCallbackQuery();
  const view = reviewView(result);
  await editHtml(ctx, view.text, { reply_markup: view.markup });
}

function fixPromptView(nonce: string, index: number, refusal?: Html): View {
  return {
    text: refusal ?? messages.chatImportFixPrompt,
    markup: InlineKeyboard.from([
      [
        InlineKeyboard.text(
          messages.chatImportBackToCardButton,
          chatImportCardData('back', nonce, index),
        ),
      ],
    ]),
  };
}

// The text typed after [Исправить]: the card at the flow's message shows again with the typed
// items, or the prompt there names the line it couldn't read.
export async function answerChatImportFixFlow(
  ctx: Context,
  deps: HandlerDeps,
  input: {
    readonly user: User;
    readonly flow: ChatImportFixFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { flow } = input;
  const result = answerChatImportFix(deps, { ...input, now: deps.now() });
  const at = { chatId: flow.chatId, messageId: flow.messageId };
  if (result.kind === 'badLine') {
    const view = fixPromptView(flow.nonce, flow.index, messages.chatImportFixBadLine(result));
    await editHtmlAt(ctx, at, view.text, { reply_markup: view.markup });
    return;
  }
  if (result.kind === 'expired') {
    await replyHtml(ctx, messages.chatImportExpired);
    return;
  }
  if (result.kind === 'stale') {
    await replyHtml(ctx, html`${messages.chatImportStale}`);
    return;
  }
  const view = reviewView(result);
  await editHtmlAt(ctx, at, view.text, { reply_markup: view.markup });
}

type CardTapService = (
  deps: HandlerDeps,
  input: {
    readonly user: User;
    readonly nonce: string;
    readonly index: number;
    readonly now: Date;
  },
) => ReviewResult;

const CARD_TAPS: Readonly<Record<Exclude<ChatImportCardAction, 'fix'>, CardTapService>> = {
  ok: recordChatImportCard,
  back: showChatImportCard,
  skip: skipChatImportCard,
  who: cycleChatImportPayer,
};

function isCardAction(value: string | undefined): value is ChatImportCardAction {
  return (
    value === 'ok' || value === 'fix' || value === 'back' || value === 'skip' || value === 'who'
  );
}

export function registerChatImport(
  bot: Composer<Context>,
  deps: HandlerDeps,
  download: FileDownloader,
): void {
  bot.on('message:document', async (ctx, next) => {
    const { document } = ctx.message;
    if (!isJson(document)) {
      await next();
      return;
    }
    if ((document.file_size ?? 0) > MAX_EXPORT_BYTES) {
      deps.logger.info({ bytes: document.file_size, outcome: 'tooLarge' }, 'chat export read');
      await replyHtml(ctx, messages.chatImportTooLarge);
      return;
    }
    const { file_path: filePath } = await ctx.api.getFile(document.file_id);
    if (filePath === undefined) {
      await next();
      return;
    }
    // One info line per file: its size and the outcome, never a message of the export.
    const read = { bytes: document.file_size };
    const parsed = readTelegramExport(new TextDecoder().decode(await download(filePath)));
    if (parsed.kind === 'notExport') {
      deps.logger.info({ ...read, outcome: 'notExport' }, 'chat export read');
      await replyHtml(ctx, messages.chatImportNotExport);
      return;
    }
    deps.logger.info(
      { ...read, outcome: 'export', messages: parsed.messages.length },
      'chat export read',
    );
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const preview = previewChatImport(deps, { user, export: parsed, now });
    if (preview.kind !== 'preview') {
      await replyHtml(
        ctx,
        preview.kind === 'groupUnknown'
          ? messages.chatImportGroupUnknown
          : preview.kind === 'tooManyMessages'
            ? messages.chatImportTooManyMessages
            : messages.chatImportTooManyItems,
      );
      return;
    }
    const view = previewView(preview);
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
  });

  // The preview's ready list pager.
  bot.callbackQuery(CHAT_IMPORT_PAGE, async (ctx) => {
    const [, nonce = '', page = ''] = ctx.match;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = currentChatImportPreview(deps, { user, nonce, now });
    if (result.kind !== 'preview') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    const view = previewView(result, Number(page));
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(CHAT_IMPORT_RECORD, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const nonce = ctx.match[1] ?? '';
    const result = recordReadyChatImport(deps, { user, nonce, now });
    if (result.kind !== 'recorded') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    if (result.reviewCount > 0) {
      keyboard
        .text(messages.chatImportReviewButton(result.reviewCount), chatImportData('rev', nonce))
        .row();
    }
    keyboard.text(messages.chatImportUndoButton, chatImportData('undo', nonce));
    await editHtml(ctx, messages.chatImportRecorded(result), { reply_markup: keyboard });
    await syncNotice(ctx, deps, user, nonce);
  });

  // [Отменить импорт]: the confirm step, with how many expenses would go.
  bot.callbackQuery(CHAT_IMPORT_UNDO, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const nonce = ctx.match[1] ?? '';
    const result = chatImportUndoCount(deps, { user, nonce, now });
    if (result.kind !== 'confirm') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.chatImportUndoConfirm(result), {
      reply_markup: InlineKeyboard.from([
        [
          InlineKeyboard.text(messages.chatImportUndoYesButton, chatImportData('undoy', nonce)),
          InlineKeyboard.text(messages.chatImportUndoNoButton, chatImportData('undon', nonce)),
        ],
      ]),
    });
  });

  // [Да, удалить]: the chat's imported expenses go, and the group's notice says so. A second tap
  // finds nothing left and changes nothing.
  bot.callbackQuery(CHAT_IMPORT_UNDO_YES, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = undoChatImport(deps, { user, nonce: ctx.match[1] ?? '', now });
    if (result.kind !== 'undone') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    if (result.count === 0) return;
    await editHtml(ctx, messages.chatImportUndone(result));
    const { notice } = result;
    if (notice === undefined || notice.messageId === null) return;
    try {
      await editHtmlAt(
        ctx,
        { chatId: notice.chatId, messageId: notice.messageId },
        messages.chatImportNoticeUndone(notice),
      );
    } catch (error) {
      deps.logger.warn(
        { userId: user.id, error: error instanceof Error ? error.message : String(error) },
        'chat import notice failed',
      );
    }
  });

  // [Нет]: nothing is deleted; the preview of the import as it stands.
  bot.callbackQuery(CHAT_IMPORT_UNDO_NO, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = currentChatImportPreview(deps, { user, nonce: ctx.match[1] ?? '', now });
    if (result.kind !== 'preview') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    const view = previewView(result);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(CHAT_IMPORT_CANCEL, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = cancelChatImport(deps, { user, nonce: ctx.match[1] ?? '', now });
    if (result !== 'cancelled') {
      await answerGone(ctx, result);
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.chatImportCancelled);
  });

  // An answer to a name prefix's question: the next question or the preview, in place.
  bot.callbackQuery(CHAT_IMPORT_PREFIX, async (ctx) => {
    const [, nonce = '', prefixIndex = '', choice = ''] = ctx.match;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = answerChatImportPrefix(deps, {
      user,
      nonce,
      prefixIndex: Number(prefixIndex),
      answer: choice === 'a' ? 'author' : choice === 'x' ? 'notName' : Number(choice),
      now,
    });
    if (result.kind !== 'preview') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    const view = previewView(result);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  // [Проверить (N)]: the first card, as a new message that later taps edit in place.
  bot.callbackQuery(CHAT_IMPORT_REVIEW, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = openChatImportReview(deps, { user, nonce: ctx.match[1] ?? '', now });
    if (result.kind === 'expired' || result.kind === 'stale') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    const view = reviewView(result);
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(CHAT_IMPORT_FINISH, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    await showReview(ctx, finishChatImportReview(deps, { user, nonce: ctx.match[1] ?? '', now }));
  });

  bot.callbackQuery(CHAT_IMPORT_CARD, async (ctx) => {
    const [, action, nonce = '', index = ''] = ctx.match;
    if (!isCardAction(action)) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const input = { user, nonce, index: Number(index), now };
    if (action !== 'fix') {
      await showReview(ctx, CARD_TAPS[action](deps, input));
      if (action === 'ok') await syncNotice(ctx, deps, user, nonce);
      return;
    }
    const message = ctx.callbackQuery.message;
    if (message === undefined) return;
    const result = startChatImportFix(deps, {
      ...input,
      chatId: message.chat.id,
      messageId: message.message_id,
    });
    if (result.kind !== 'prompt') {
      await showReview(ctx, result);
      return;
    }
    await ctx.answerCallbackQuery();
    const view = fixPromptView(nonce, input.index);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(CHAT_IMPORT_READING, async (ctx) => {
    const [, nonce = '', index = '', reading = ''] = ctx.match;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    await showReview(
      ctx,
      pickChatImportReading(deps, {
        user,
        nonce,
        index: Number(index),
        reading: Number(reading),
        now,
      }),
    );
    await syncNotice(ctx, deps, user, nonce);
  });
}
