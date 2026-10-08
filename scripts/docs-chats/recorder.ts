// Turns the Bot API calls the test harness recorded into a chat transcript for the docs site
// (ADR-0048): what a user of that chat would see, in order. Only calls to the scenario's own chat
// count; everything else the bot sent (the admin's notices) is not in that chat.
import type { ApiCall } from '../../src/bot/testHarness.js';

export interface Button {
  readonly text: string;
  readonly kind: 'callback' | 'url' | 'web_app';
  // web_app only: the `#z=…` the Mini App reads.
  readonly fragment?: string;
}

export type Bubble =
  | { readonly from: 'user'; readonly text: string }
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
  readonly replyKeyboard?: readonly (readonly string[])[];
}

// Where a tap goes: the button's callback data and the message that carries it.
export interface TapTarget {
  readonly data: string;
  readonly messageId: number;
}

interface RawButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly url?: string;
  readonly web_app?: { readonly url: string };
}

interface MessagePayload {
  readonly chat_id: number;
  readonly text?: string;
  readonly reply_markup?: { readonly inline_keyboard?: readonly (readonly RawButton[])[] };
}

interface Entry {
  readonly bubble: Bubble;
  // A bot bubble's message id, as `withMessageIds` hands them out; undefined for the rest.
  readonly messageId?: number;
  readonly raw?: readonly (readonly RawButton[])[];
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

export function createRecorder(chatId: number) {
  const entries: Entry[] = [];
  let lastMessageId = FIRST_MESSAGE_ID;

  function botEntry(payload: MessagePayload, messageId: number): Entry {
    const raw = payload.reply_markup?.inline_keyboard;
    const buttons = raw?.map((row) => row.map(buttonOf));
    return {
      bubble: {
        from: 'bot',
        html: payload.text ?? '',
        ...(buttons === undefined || buttons.length === 0 ? {} : { buttons }),
      },
      messageId,
      ...(raw === undefined ? {} : { raw }),
    };
  }

  // Applies one call, and returns whether it changed the chat.
  function applyOne({ method, payload }: ApiCall): boolean {
    const p = payload as MessagePayload;
    if (p.chat_id !== chatId) return false;
    if (method === 'sendMessage') {
      lastMessageId += 1;
      entries.push(botEntry(p, lastMessageId));
      return true;
    }
    return false;
  }

  return {
    user(text: string): void {
      entries.push({ bubble: { from: 'user', text } });
    },
    // Applies the calls one step produced, and returns how many changed the chat.
    apply(calls: readonly ApiCall[]): number {
      return calls.filter(applyOne).length;
    },
    // The callback button labelled `label` in the latest bot bubble that has buttons.
    target(label: string): TapTarget | undefined {
      const latest = entries.findLast((entry) => entry.raw !== undefined);
      if (latest?.messageId === undefined) return undefined;
      const button = latest.raw?.flat().find((b) => b.text === label);
      if (button?.callback_data === undefined) return undefined;
      return { data: button.callback_data, messageId: latest.messageId };
    },
    transcript(name: string): Transcript {
      return { name, bubbles: entries.map((entry) => entry.bubble) };
    },
  };
}
