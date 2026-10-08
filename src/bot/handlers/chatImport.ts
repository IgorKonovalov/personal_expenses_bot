import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Document } from 'grammy/types';
import { readTelegramExport } from '../../domain/chatImport/telegramExport.js';
import type { FileDownloader } from '../../jobs/child.js';
import {
  cancelChatImport,
  previewChatImport,
  recordReadyChatImport,
  type ChatImportPreview,
} from '../../services/importChat.js';
import type { HandlerDeps } from '../bot.js';
import { CHAT_IMPORT_CANCEL, CHAT_IMPORT_RECORD, chatImportData } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import { ensureUser } from './start.js';

// A group's history from a Telegram Desktop JSON export, sent in DM (ADR-0047): read in memory,
// previewed against the group's ledger, and recorded by a tap. A document that isn't JSON goes
// on to the handlers after this one. Register before the statement handler.

function isJson(document: Document): boolean {
  return (
    document.mime_type === 'application/json' ||
    document.file_name?.toLowerCase().endsWith('.json') === true
  );
}

function previewView(preview: ChatImportPreview) {
  const keyboard = new InlineKeyboard();
  if (preview.ready.length > 0) {
    keyboard
      .text(
        messages.chatImportRecordButton(preview.ready.length),
        chatImportData('rec', preview.nonce),
      )
      .row();
  }
  keyboard.text(messages.cancelButton, chatImportData('x', preview.nonce));
  return {
    text: messages.chatImportPreview({ ...preview, readyCount: preview.ready.length }),
    markup: keyboard,
  };
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
    const result = recordReadyChatImport(deps, { user, nonce: ctx.match[1] ?? '', now });
    if (result.kind !== 'recorded') {
      await answerGone(ctx, result.kind);
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.chatImportRecorded(result));
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
}
