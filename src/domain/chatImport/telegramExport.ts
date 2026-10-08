// A Telegram Desktop chat export (`result.json`, ADR-0047) read into the messages an import
// needs. The format is not a documented API: only the fields named here are read, and anything
// else about a message is ignored.

export interface ExportedMessage {
  // The Telegram message id in that chat.
  readonly id: number;
  // From `date_unixtime`.
  readonly at: Date;
  readonly senderTelegramId: number;
  // `from`; null for a deleted account.
  readonly senderName: string | null;
  // The text, or a media message's caption, with its formatting dropped.
  readonly text: string;
  readonly forwarded: boolean;
}

export type ExportRead =
  | {
      readonly kind: 'export';
      // The export's own `id`: a supergroup's chat id without `-100`, a basic group's without `-`.
      readonly chatId: number;
      readonly name: string;
      readonly type: string;
      readonly messages: readonly ExportedMessage[];
    }
  // Not JSON, not a chat export, or an export of a chat that isn't a group.
  | { readonly kind: 'notExport' };

const NOT_EXPORT = { kind: 'notExport' } as const;

// Reads an export of one group chat. A private chat, a channel or a whole-account export is
// `notExport`. Only a `message` from a `user<digits>` sender is kept: service messages and
// messages a channel or a bot posted are dropped.
export function readTelegramExport(text: string): ExportRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NOT_EXPORT;
  }
  if (!isRecord(parsed)) return NOT_EXPORT;
  const { id, name, type, messages } = parsed;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return NOT_EXPORT;
  if (typeof type !== 'string' || !type.includes('group')) return NOT_EXPORT;
  if (!Array.isArray(messages)) return NOT_EXPORT;
  return {
    kind: 'export',
    chatId: id,
    name: typeof name === 'string' ? name : '',
    type,
    messages: messages.flatMap((message) => {
      const read = readMessage(message);
      return read === undefined ? [] : [read];
    }),
  };
}

const USER_SENDER = /^user(\d{1,15})$/;
const UNIX_SECONDS = /^\d{1,12}$/;

function readMessage(message: unknown): ExportedMessage | undefined {
  if (!isRecord(message) || message.type !== 'message') return undefined;
  const { id, from, from_id: fromId, date_unixtime: unixtime } = message;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const sender = typeof fromId === 'string' ? USER_SENDER.exec(fromId)?.[1] : undefined;
  if (sender === undefined) return undefined;
  if (typeof unixtime !== 'string' || !UNIX_SECONDS.test(unixtime)) return undefined;
  return {
    id,
    at: new Date(Number(unixtime) * 1000),
    senderTelegramId: Number(sender),
    senderName: typeof from === 'string' ? from : null,
    text: textOf(message.text),
    forwarded: message.forwarded_from !== undefined,
  };
}

// `text` is a string, or an array of strings and `{ type, text }` entities, joined in order.
function textOf(text: unknown): string {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '';
  return text
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
