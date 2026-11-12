import type { Api, Context } from 'grammy';
import type { InlineKeyboardMarkup, Message, Update, User } from 'grammy/types';
import { WIDGET_PROGRAMS, type WidgetProgram } from './widgets/programs.generated.js';

// Bot API 10.4's widget methods and the `widget_query` update (ADR-0053), the one place the bot
// touches them. grammY 1.46.0 predates 10.4, so the calls go through `api.raw`, which forwards
// any method name, typed by the local interfaces below, written from
// https://core.telegram.org/bots/api#sendwidget and #answerwidgetquery. A misspelled parameter
// fails only at runtime: bot.test.ts asserts the exact method names and keys.

interface SendWidgetParams {
  readonly chat_id: number;
  // 1-32768 bytes, at most 4096 after zlib level 9.
  readonly html: string;
  // 50-600 logical pixels; omitted, the height follows the content.
  readonly height?: number;
  // 0-1024 bytes, this message's state.
  readonly chat_data?: string;
  readonly caption?: string;
  readonly allow_queries?: boolean;
  readonly reply_markup?: InlineKeyboardMarkup;
}

interface AnswerWidgetQueryParams {
  readonly widget_query_id: string;
  // 0-1024 bytes, received only by the widget that asked.
  readonly data?: string;
}

interface WidgetRawApi {
  sendWidget(params: SendWidgetParams): Promise<Message>;
  answerWidgetQuery(params: AnswerWidgetQueryParams): Promise<true>;
}

function raw(api: Api): WidgetRawApi {
  return api.raw as unknown as WidgetRawApi;
}

// The height every program draws in (widgets/src/runtime.ts's frame), fixed so the bubble
// doesn't jump between a program's states.
export const WIDGET_HEIGHT = 380;

export interface WidgetMessage {
  readonly program: WidgetProgram;
  readonly chatData: string;
  readonly caption: string;
  // Lets the program's taps reach the bot as widget queries.
  readonly queries: boolean;
  readonly markup?: InlineKeyboardMarkup;
}

// Sends `program` as a new message in the update's chat. The caption is plain text: no
// parse_mode, so nothing in it needs escaping.
export async function replyWidget(ctx: Context, widget: WidgetMessage): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error('a widget needs a chat');
  await raw(ctx.api).sendWidget({
    chat_id: chatId,
    html: WIDGET_PROGRAMS[widget.program],
    height: WIDGET_HEIGHT,
    chat_data: widget.chatData,
    caption: widget.caption,
    ...(widget.queries ? { allow_queries: true } : {}),
    ...(widget.markup === undefined ? {} : { reply_markup: widget.markup }),
  });
}

// A widget's request (https://core.telegram.org/bots/api#widgetquery), the fields the bot reads.
export interface WidgetQuery {
  readonly id: string;
  readonly from: User;
  readonly data: string;
}

// The update's widget query, or undefined for any other update. Read off the raw update, which
// grammY passes through untouched; the shape is checked, since grammY's types don't know it.
export function widgetQueryOf(update: Update): WidgetQuery | undefined {
  const query: unknown = (update as { readonly widget_query?: unknown }).widget_query;
  if (typeof query !== 'object' || query === null) return undefined;
  const { id, from, data } = query as Record<string, unknown>;
  if (typeof id !== 'string' || typeof data !== 'string') return undefined;
  if (typeof from !== 'object' || from === null) return undefined;
  if (typeof (from as { readonly id?: unknown }).id !== 'number') return undefined;
  return { id, from: from as User, data };
}

export async function answerWidgetQuery(api: Api, queryId: string, data: string): Promise<void> {
  await raw(api).answerWidgetQuery({ widget_query_id: queryId, data });
}
