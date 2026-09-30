import { GrammyError, type Context } from 'grammy';
import type { Message } from 'grammy/types';

// Every outgoing message text is Telegram HTML minted here (ADR-0012). An `Html` value is either
// static copy from source or user text that went through `escapeHtml`, so a `<` or `&` typed by
// the user can never make Telegram reject the message.

export type Html = string & { readonly __brand: 'html' };

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(text: string): Html {
  return text.replace(/[&<>"]/g, (char) => ENTITIES[char] ?? char) as Html;
}

// An interpolated `Html` would be escaped a second time, so the type rejects it: combine `Html`
// parts with `joinHtml` instead.
type PlainValues<V extends readonly unknown[]> = {
  [K in keyof V]: V[K] extends Html ? never : V[K];
};

// Static parts are trusted markup; every interpolated value is escaped.
export function html<V extends readonly (string | number)[]>(
  strings: TemplateStringsArray,
  ...values: PlainValues<V>
): Html {
  return strings.reduce(
    (out, part, i) => (i === 0 ? part : `${out}${escapeHtml(String(values[i - 1]))}${part}`),
    '',
  ) as Html;
}

// Parts are already `Html` and are not re-escaped; the separator is plain text.
export function joinHtml(parts: readonly Html[], separator: string): Html {
  return parts.join(escapeHtml(separator)) as Html;
}

// The one place that sets parse_mode. Tests spread it into expected payloads.
export const htmlParseMode = { parse_mode: 'HTML' } as const;

type ReplyOther = Omit<NonNullable<Parameters<Context['reply']>[1]>, 'parse_mode'>;
type EditOther = Omit<NonNullable<Parameters<Context['editMessageText']>[1]>, 'parse_mode'>;

export function replyHtml(ctx: Context, body: Html, extra: ReplyOther = {}): Promise<Message> {
  return ctx.reply(body, { ...extra, ...htmlParseMode });
}

// Telegram answers an edit to identical text and markup with 400 "message is not modified".
// The message already shows what was asked for, so that counts as success (ADR-0011).
export async function editHtml(ctx: Context, body: Html, extra: EditOther = {}): Promise<void> {
  try {
    await ctx.editMessageText(body, { ...extra, ...htmlParseMode });
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes('message is not modified')) {
      return;
    }
    throw error;
  }
}
