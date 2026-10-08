// Turns the Bot API calls the test harness recorded into a chat transcript for the docs site
// (ADR-0048): what a user of that chat would see, in order. Only calls to the scenario's own chat
// count; everything else the bot sent (the admin's notices) is not in that chat. Methods the
// chat doesn't show (setMyCommands, setChatMenuButton, reactions…) are dropped.
import type { ApiCall } from '../../src/bot/testHarness.js';

export interface Button {
  readonly text: string;
  readonly kind: 'callback' | 'url' | 'web_app';
  // web_app only: the `#z=…` the Mini App reads.
  readonly fragment?: string;
}

export type Bubble =
  // `author` names a group member; a private chat has one user and no name.
  | { readonly from: 'user'; readonly text: string; readonly author?: string }
  | {
      readonly from: 'bot';
      readonly html: string;
      readonly buttons?: readonly (readonly Button[])[];
    }
  | { readonly from: 'bot-file'; readonly fileName: string }
  | { readonly from: 'toast'; readonly text: string };

export interface Transcript {
  readonly name: string;
  readonly bubbles: readonly Bubble[];
  // The chat's bottom keyboard after the last step, if it has one.
  readonly replyKeyboard?: readonly (readonly string[])[];
}

// Where a tap goes: the button's callback data, the message that carries it, and the message
// that one replies to, if any.
export interface TapTarget {
  readonly data: string;
  readonly messageId: number;
  readonly replyTo?: number;
}

interface RawButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly url?: string;
  readonly web_app?: { readonly url: string };
}

type RawKeyButton = string | { readonly text: string };

interface Markup {
  readonly inline_keyboard?: readonly (readonly RawButton[])[];
  readonly keyboard?: readonly (readonly RawKeyButton[])[];
  readonly remove_keyboard?: boolean;
}

// The payload fields the rules below read, across the methods they handle.
interface Payload {
  readonly chat_id?: number;
  readonly message_id?: number;
  readonly text?: string;
  readonly reply_markup?: Markup;
  readonly reply_parameters?: { readonly message_id: number };
  readonly document?: unknown;
  readonly photo?: unknown;
  readonly media?: readonly { readonly media: unknown }[];
}

interface Entry {
  bubble: Bubble;
  // The message id: a user's from the scenario, a bot text's as `withMessageIds` hands them out.
  readonly messageId?: number;
  readonly replyTo?: number;
  raw?: readonly (readonly RawButton[])[];
}

// The first message id `withMessageIds` hands out, minus one: its default `first`.
const FIRST_MESSAGE_ID = 100;

function buttonOf(raw: RawButton): Button {
  if (raw.web_app !== undefined) {
    const hash = raw.web_app.url.indexOf('#');
    return {
      text: raw.text,
      kind: 'web_app',
      ...(hash === -1 ? {} : { fragment: raw.web_app.url.slice(hash) }),
    };
  }
  if (raw.url !== undefined) return { text: raw.text, kind: 'url' };
  return { text: raw.text, kind: 'callback' };
}

// An uploaded file's name: grammY's InputFile carries it as `filename`; a file sent by id or URL
// has none.
function fileNameOf(file: unknown, fallback: string): string {
  if (typeof file === 'object' && file !== null && 'filename' in file) {
    const { filename } = file as { filename?: unknown };
    if (typeof filename === 'string' && filename !== '') return filename;
  }
  return fallback;
}

function botBubble(text: string, raw: readonly (readonly RawButton[])[] | undefined): Bubble {
  const buttons = raw?.map((row) => row.map(buttonOf)).filter((row) => row.length > 0);
  return {
    from: 'bot',
    html: text,
    ...(buttons === undefined || buttons.length === 0 ? {} : { buttons }),
  };
}

export function createRecorder(chatId: number) {
  const entries: Entry[] = [];
  let lastMessageId = FIRST_MESSAGE_ID;
  let replyKeyboard: (readonly string[])[] | undefined;

  const find = (messageId: number | undefined) =>
    messageId === undefined ? -1 : entries.findIndex((entry) => entry.messageId === messageId);

  function keepReplyKeyboard(markup: Markup | undefined): void {
    if (markup?.remove_keyboard === true) replyKeyboard = undefined;
    if (markup?.keyboard !== undefined) {
      replyKeyboard = markup.keyboard.map((row) =>
        row.map((button) => (typeof button === 'string' ? button : button.text)),
      );
    }
  }

  // Applies one call, and returns whether it changed the chat. `tapped` is the message whose
  // button the step tapped, where its toast goes.
  function applyOne({ method, payload }: ApiCall, tapped: number | undefined): boolean {
    const p = payload as Payload;
    if (method === 'answerCallbackQuery') {
      if (p.text === undefined || p.text === '') return false;
      const at = find(tapped);
      const toast: Entry = { bubble: { from: 'toast', text: p.text } };
      if (at === -1) entries.push(toast);
      else entries.splice(at + 1, 0, toast);
      return true;
    }
    if (p.chat_id !== chatId) return false;
    switch (method) {
      case 'sendMessage': {
        lastMessageId += 1;
        const raw = p.reply_markup?.inline_keyboard;
        keepReplyKeyboard(p.reply_markup);
        entries.push({
          bubble: botBubble(p.text ?? '', raw),
          messageId: lastMessageId,
          ...(p.reply_parameters === undefined ? {} : { replyTo: p.reply_parameters.message_id }),
          ...(raw === undefined || raw.length === 0 ? {} : { raw }),
        });
        return true;
      }
      case 'editMessageText':
      case 'editMessageReplyMarkup': {
        const entry = entries[find(p.message_id)];
        if (entry?.bubble.from !== 'bot') return false;
        const raw = p.reply_markup?.inline_keyboard;
        const text = method === 'editMessageText' ? (p.text ?? '') : entry.bubble.html;
        // An edit without reply_markup drops the message's keyboard, as Telegram does.
        entry.bubble = botBubble(text, raw);
        if (raw === undefined || raw.length === 0) delete entry.raw;
        else entry.raw = raw;
        return true;
      }
      case 'deleteMessage': {
        const at = find(p.message_id);
        if (at === -1) return false;
        entries.splice(at, 1);
        return true;
      }
      case 'sendDocument':
      case 'sendPhoto': {
        const file = method === 'sendDocument' ? p.document : p.photo;
        const fallback = method === 'sendDocument' ? 'файл' : 'фото';
        entries.push({ bubble: { from: 'bot-file', fileName: fileNameOf(file, fallback) } });
        return true;
      }
      case 'sendMediaGroup': {
        for (const item of p.media ?? []) {
          entries.push({ bubble: { from: 'bot-file', fileName: fileNameOf(item.media, 'файл') } });
        }
        return true;
      }
      default:
        return false;
    }
  }

  return {
    user(text: string, messageId?: number, author?: string): void {
      entries.push({
        bubble: { from: 'user', text, ...(author === undefined ? {} : { author }) },
        ...(messageId === undefined ? {} : { messageId }),
      });
    },
    // Forgets every bubble so far; the bottom keyboard stays, as it does in the chat.
    cut(): void {
      entries.length = 0;
    },
    // Applies the calls one step produced, and returns how many changed the chat.
    apply(calls: readonly ApiCall[], tapped?: number): number {
      return calls.filter((call) => applyOne(call, tapped)).length;
    },
    // The callback button labelled `label` in the latest bot bubble that has buttons.
    target(label: string): TapTarget | undefined {
      const latest = entries.findLast((entry) => entry.raw !== undefined);
      if (latest?.messageId === undefined) return undefined;
      const button = latest.raw?.flat().find((b) => b.text === label);
      if (button?.callback_data === undefined) return undefined;
      return {
        data: button.callback_data,
        messageId: latest.messageId,
        ...(latest.replyTo === undefined ? {} : { replyTo: latest.replyTo }),
      };
    },
    transcript(name: string): Transcript {
      return {
        name,
        bubbles: entries.map((entry) => entry.bubble),
        ...(replyKeyboard === undefined ? {} : { replyKeyboard }),
      };
    },
  };
}
