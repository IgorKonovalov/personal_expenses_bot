import { InlineKeyboard, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../db/users.js';
import {
  currentAnchor,
  setAnchor,
  type Screen,
  type ScreenAnchor,
} from '../services/flowSessions.js';
import type { HandlerDeps } from './bot.js';
import { FLOW_CANCEL } from './callbackData.js';
import { messages } from './messages.js';
import { editHtmlAt, replyHtml, type Html } from './render/html.js';
import { ensureUser } from './handlers/start.js';

// The screen half of ADR-0011's kit. A screen (hub, picker, prompt) lives in the user's one
// anchor message, stored in the ADR-0009 session row. Opening a screen sends a new message that
// replaces the anchor; a screen callback on any other message is stale.

export interface ScreenView {
  readonly text: Html;
  readonly markup: InlineKeyboard;
}

// Sends the screen as a new message and makes it the user's anchor.
export async function showScreen(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  screen: Screen,
  view: ScreenView,
): Promise<void> {
  const sent = await replyHtml(ctx, view.text, { reply_markup: view.markup });
  setAnchor(deps, user, { chatId: sent.chat.id, messageId: sent.message_id, screen });
}

export interface ScreenTap {
  readonly user: User;
  readonly anchor: ScreenAnchor;
}

// The prologue of every screen callback: the tapped message must be the tapper's current
// anchor. Otherwise the tap gets the staleScreen toast and the handler stops. The anchor's
// `screen` says what it shows; a handler for several screens switches on it.
export async function requireScreen(
  ctx: Context,
  deps: HandlerDeps,
): Promise<ScreenTap | undefined> {
  const tapped = ctx.callbackQuery?.message;
  if (ctx.from === undefined || tapped === undefined) return undefined;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const anchor = currentAnchor(deps, user);
  if (
    anchor === undefined ||
    anchor.chatId !== tapped.chat.id ||
    anchor.messageId !== tapped.message_id
  ) {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { user, anchor };
}

// Re-renders the anchor in place, from any update: a callback, a typed answer, /cancel.
export async function renderAnchor(
  ctx: Context,
  anchor: ScreenAnchor,
  view: ScreenView,
): Promise<void> {
  await editHtmlAt(ctx, anchor, view.text, { reply_markup: view.markup });
}

// [« Назад] alone on the bottom row.
export function backRow(data: string): InlineKeyboardButton[] {
  return [InlineKeyboard.text(messages.backButton, data)];
}

// [Отмена] under a text prompt.
export function cancelRow(): InlineKeyboardButton[] {
  return [InlineKeyboard.text(messages.cancelButton, FLOW_CANCEL)];
}
