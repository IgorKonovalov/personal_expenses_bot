import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Document } from 'grammy/types';
import { isAmbiguousItem } from '../../domain/chatImport/readMessage.js';
import { readTelegramExport } from '../../domain/chatImport/telegramExport.js';
import type { FileDownloader } from '../../jobs/child.js';
import type { User } from '../../db/users.js';
import type { ChatImportFixFlow } from '../../services/flowSessions.js';
import {
  answerChatImportFix,
  cancelChatImport,
  cycleChatImportPayer,
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
  CHAT_IMPORT_READING,
  CHAT_IMPORT_RECORD,
  CHAT_IMPORT_REVIEW,
  chatImportCardData,
  chatImportData,
  chatImportReadingData,
  type ChatImportCardAction,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, editHtmlAt, html, replyHtml, type Html } from '../render/html.js';
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

function previewView(preview: ChatImportPreview): View {
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
  keyboard.text(messages.cancelButton, chatImportData('x', preview.nonce));
  return {
    text: messages.chatImportPreview({ ...preview, readyCount: preview.ready.length }),
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
    keyboard.text(
      messages.chatImportRecordButton(view.readyCount),
      chatImportData('rec', view.nonce),
    );
  }
  return { text: messages.chatImportReviewDone(view), markup: keyboard };
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
    if (preview.kind === 'groupUnknown') {
      await replyHtml(ctx, messages.chatImportGroupUnknown);
      return;
    }
    const view = previewView(preview);
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
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
      keyboard.text(
        messages.chatImportReviewButton(result.reviewCount),
        chatImportData('rev', nonce),
      );
    }
    await editHtml(ctx, messages.chatImportRecorded(result), { reply_markup: keyboard });
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
  });
}
