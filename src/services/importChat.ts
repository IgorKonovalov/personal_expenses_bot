import { createHash } from 'node:crypto';
import { listActiveCategories } from '../db/categories.js';
import {
  deleteChatImport,
  deleteExpiredChatImport,
  findChatImport,
  joinImportedMember,
  listExpiredChatImports,
  saveChatImport,
  updateChatImport,
  type ChatImportRow,
} from '../db/chatImports.js';
import { findTakenSourceKeys, type ExpenseId } from '../db/expenses.js';
import { findFirstLedgerChat } from '../db/ledgerChats.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import {
  readMessage,
  type MessageRead,
  type ProposedItem,
} from '../domain/chatImport/readMessage.js';
import type { ExportedMessage, ExportRead } from '../domain/chatImport/telegramExport.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { Money } from '../domain/money.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { provisionUser } from './provisionUser.js';
import {
  historyCategory,
  resolveLedgerTimezone,
  storeExpense,
  type RecordDeps,
} from './recordExpense.js';

// A group's history from before the bot joined, imported from a Telegram Desktop export
// (ADR-0047). The upload is read into the user's chat_imports row, which outlives the pending-flow
// slot: it lives CHAT_IMPORT_TTL_MS after the upload or the last tap. Every button carries the
// row's nonce, so a button from an earlier upload never acts on a later one. Each item is stored
// under `tgx:<chatId>:<messageId>:<itemIndex>`, so sending the file again records nothing twice.
// Logs carry counts only, never a message's text, a description or an amount.

export const CHAT_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChatImportDeps extends RecordDeps {
  // A sender's new personal ledger's currency.
  readonly defaultCurrency: CurrencyCode;
}

// A message kept in the row: one sent before the bot joined that has a digit in it.
interface StoredMessage {
  readonly id: number;
  // ISO instant.
  readonly at: string;
  readonly sender: number;
  readonly name: string | null;
  readonly text: string;
  readonly forwarded: boolean;
}

interface Sender {
  readonly telegramId: number;
  readonly name: string | null;
  readonly count: number;
}

type Decision = 'recorded' | 'skipped';

interface Payload {
  readonly messages: readonly StoredMessage[];
  // Messages before the bot joined with no digit in them.
  readonly noAmount: number;
  // The first and last message before the bot joined, ISO instants; absent when there is none.
  readonly first?: string;
  readonly last?: string;
  // Every sender of a message before the bot joined, most messages first.
  readonly senders: readonly Sender[];
  // Per message id.
  readonly decisions: Readonly<Record<string, Decision>>;
}

// A ready item with what the preview's list shows of its message.
export interface ReadyItem extends ProposedItem {
  readonly messageId: number;
  readonly senderName: string | null;
}

export interface ChatImportPreview {
  readonly kind: 'preview';
  readonly nonce: string;
  readonly ledger: Ledger;
  // The local dates of the first and last message before the bot joined; absent for none.
  readonly from?: LocalDate;
  readonly to?: LocalDate;
  readonly ready: readonly ReadyItem[];
  readonly readyMessages: number;
  // The ready items' totals per currency, in order of first appearance; never converted.
  readonly totals: readonly Money[];
  readonly alreadyCount: number;
  readonly skippedCount: number;
  readonly reviewCount: number;
  readonly noAmountCount: number;
}

export type PreviewResult =
  | ChatImportPreview
  // No binding for the export's chat, or one the user isn't a member of: the same answer.
  | { readonly kind: 'groupUnknown' };

// Reads the export against the group's ledger, saves it in the user's row under a new nonce and
// describes the preview. The binding's chat id is `-100<id>` for a supergroup or `-<id>` for a
// basic group; both are tried. Only messages sent before the binding are read. A new export of
// the chat the row already holds keeps the row's decisions; one of another chat replaces it.
export function previewChatImport(
  deps: ChatImportDeps,
  input: {
    readonly user: User;
    readonly export: Extract<ExportRead, { kind: 'export' }>;
    readonly now: Date;
  },
): PreviewResult {
  const { db, logger } = deps;
  const { user, now } = input;
  const binding = findFirstLedgerChat(db, 'telegram', [
    `-100${input.export.chatId}`,
    `-${input.export.chatId}`,
  ]);
  const ledger =
    binding === undefined ? undefined : findLedgerForMember(db, binding.ledgerId, user.id);
  if (binding === undefined || ledger === undefined || ledger.timezone === null) {
    logger.info({ userId: user.id, bound: binding !== undefined }, 'chat import refused');
    return { kind: 'groupUnknown' };
  }

  const before = input.export.messages.filter((message) => message.at < binding.boundAt);
  const earlier = findChatImport(db, user.id);
  const kept = earlier?.chatId === binding.chatId ? parsePayload(earlier.payload) : undefined;
  const payload: Payload = {
    messages: before.filter((message) => /\d/.test(message.text)).map(storedMessage),
    noAmount: before.filter((message) => !/\d/.test(message.text)).length,
    ...range(before),
    senders: sendersOf(before),
    decisions: kept?.decisions ?? {},
  };
  const nonce = newNonce(deps.newId);
  saveChatImport(db, {
    userId: user.id,
    ledgerId: ledger.id,
    chatId: binding.chatId,
    nonce,
    payload: JSON.stringify(payload),
    noticeMessageId: earlier?.chatId === binding.chatId ? earlier.noticeMessageId : null,
    expiresAt: new Date(now.getTime() + CHAT_IMPORT_TTL_MS),
  });
  const preview = describe(deps, { ledger, chatId: binding.chatId, nonce, payload });
  logger.info(
    {
      userId: user.id,
      ledgerId: ledger.id,
      messages: input.export.messages.length,
      before: before.length,
      ready: preview.ready.length,
      readyMessages: preview.readyMessages,
      review: preview.reviewCount,
      already: preview.alreadyCount,
      skipped: preview.skippedCount,
      noAmount: preview.noAmountCount,
    },
    'chat import previewed',
  );
  return preview;
}

// A tap's row: `expired` with no row, past its expiry, or a ledger the user left; `stale` for a
// button of an earlier upload.
type Held =
  | {
      readonly kind: 'held';
      readonly row: ChatImportRow;
      readonly ledger: Ledger;
      readonly payload: Payload;
    }
  | { readonly kind: 'expired' }
  | { readonly kind: 'stale' };

function held(deps: ChatImportDeps, user: User, nonce: string, now: Date): Held {
  const row = findChatImport(deps.db, user.id);
  if (row === undefined || row.expiresAt <= now) return { kind: 'expired' };
  if (row.nonce !== nonce) return { kind: 'stale' };
  const ledger = findLedgerForMember(deps.db, row.ledgerId, user.id);
  if (ledger === undefined || ledger.timezone === null) return { kind: 'expired' };
  return { kind: 'held', row, ledger, payload: parsePayload(row.payload) };
}

export type RecordReadyResult =
  | {
      readonly kind: 'recorded';
      readonly ledger: Ledger;
      // The expenses this tap created.
      readonly count: number;
      readonly totals: readonly Money[];
      // How many of them landed in the fallback category («Другое»).
      readonly otherCount: number;
    }
  | { readonly kind: 'expired' }
  | { readonly kind: 'stale' };

// [Записать N трат]: records every ready message not yet recorded or skipped, in one
// transaction. Each sender is provisioned and joins the ledger as a member, as in live group
// recording (ADR-0014). An item is dated by its message: `occurred_at` the message's instant,
// `occurred_on` its local date in the ledger's timezone, or the date a date word named.
export function recordReadyChatImport(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): RecordReadyResult {
  const { db, logger } = deps;
  const { user, nonce, now } = input;
  const result = db.transaction((): RecordReadyResult => {
    const tap = held(deps, user, nonce, now);
    if (tap.kind !== 'held') return tap;
    const { row, ledger, payload } = tap;
    const statuses = classify(deps, { ledger, chatId: row.chatId, payload });
    const created: ProposedItem[] = [];
    let otherCount = 0;
    const decisions: Record<string, Decision> = { ...payload.decisions };
    for (const { message, status } of statuses) {
      if (status.kind !== 'ready') continue;
      const sender = senderUser(deps, ledger, message, now);
      for (const [index, item] of status.items.entries()) {
        const stored = storeItem(deps, {
          ledger,
          createdBy: sender,
          item,
          at: new Date(message.at),
          sourceKey: importSourceKey(row.chatId, message.id, index),
          now,
        });
        if (stored === undefined) continue;
        created.push(item);
        if (stored.fallback) otherCount += 1;
      }
      decisions[String(message.id)] = 'recorded';
    }
    renew(deps, row, { ...payload, decisions }, now);
    return {
      kind: 'recorded',
      ledger,
      count: created.length,
      totals: totalsOf(created),
      otherCount,
    };
  })();
  if (result.kind === 'recorded') {
    logger.info(
      { userId: user.id, ledgerId: result.ledger.id, recorded: result.count },
      'chat import recorded',
    );
  }
  return result;
}

// [Отмена] on the preview: the row goes.
export function cancelChatImport(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): 'cancelled' | 'expired' | 'stale' {
  const tap = held(deps, input.user, input.nonce, input.now);
  if (tap.kind !== 'held') return tap.kind;
  deleteChatImport(deps.db, input.user.id);
  deps.logger.info({ userId: input.user.id }, 'chat import cancelled');
  return 'cancelled';
}

// The rows whose time ran out by `now`.
export function expiredChatImports({ db }: Pick<ChatImportDeps, 'db'>, now: Date): UserId[] {
  return listExpiredChatImports(db, now);
}

// Deletes an expired row, unless a tap renewed it meanwhile. True when this call deleted it.
export function sweepChatImport(
  { db, logger }: Pick<ChatImportDeps, 'db' | 'logger'>,
  userId: UserId,
  now: Date,
): boolean {
  const deleted = deleteExpiredChatImport(db, userId, now);
  if (deleted) logger.info({ userId }, 'chat import expired');
  return deleted;
}

// `tgx:<chatId>:<messageId>:<itemIndex>`.
export function importSourceKey(chatId: string, messageId: number, index: number): string {
  return `tgx:${chatId}:${messageId}:${index}`;
}

type Status =
  | { readonly kind: 'already' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'ready'; readonly items: readonly ProposedItem[] }
  | { readonly kind: 'review'; readonly read: Extract<MessageRead, { verdict: 'review' }> };

interface Classified {
  readonly message: StoredMessage;
  readonly status: Status;
}

// Where each kept message stands: recorded (its first item's key is stored, by this import or an
// earlier one), skipped in this row, ready or to review.
function classify(
  deps: ChatImportDeps,
  input: { readonly ledger: Ledger; readonly chatId: string; readonly payload: Payload },
): Classified[] {
  const { ledger, chatId, payload } = input;
  const timezone = ledgerZone(deps, ledger);
  const taken = findTakenSourceKeys(
    deps.db,
    payload.messages.map((message) => importSourceKey(chatId, message.id, 0)),
  );
  return payload.messages.map((message): Classified => {
    if (taken.has(importSourceKey(chatId, message.id, 0))) {
      return { message, status: { kind: 'already' } };
    }
    if (payload.decisions[String(message.id)] === 'skipped') {
      return { message, status: { kind: 'skipped' } };
    }
    const read = readMessage(
      message.text,
      ledger.defaultCurrency,
      localDateOf(new Date(message.at), timezone),
      { forwarded: message.forwarded, deletedSender: message.name === null },
    );
    // A message is kept only with a digit in it, so noAmount doesn't come back.
    if (read.verdict === 'review') return { message, status: { kind: 'review', read } };
    if (read.verdict === 'ready') return { message, status: { kind: 'ready', items: read.items } };
    return {
      message,
      status: { kind: 'review', read: { verdict: 'review', reason: 'unread', items: [] } },
    };
  });
}

function describe(
  deps: ChatImportDeps,
  input: {
    readonly ledger: Ledger;
    readonly chatId: string;
    readonly nonce: string;
    readonly payload: Payload;
  },
): ChatImportPreview {
  const { ledger, payload } = input;
  const statuses = classify(deps, input);
  const ready = statuses.flatMap(({ message, status }) =>
    status.kind === 'ready'
      ? status.items.map((item) => ({ ...item, messageId: message.id, senderName: message.name }))
      : [],
  );
  const count = (kind: Status['kind']) =>
    statuses.filter(({ status }) => status.kind === kind).length;
  const timezone = ledgerZone(deps, ledger);
  return {
    kind: 'preview',
    nonce: input.nonce,
    ledger,
    ...(payload.first === undefined
      ? {}
      : { from: localDateOf(new Date(payload.first), timezone) }),
    ...(payload.last === undefined ? {} : { to: localDateOf(new Date(payload.last), timezone) }),
    ready,
    readyMessages: count('ready'),
    totals: totalsOf(ready),
    alreadyCount: count('already'),
    skippedCount: count('skipped'),
    reviewCount: count('review'),
    noAmountCount: payload.noAmount,
  };
}

// A bound group's ledger is shared, so it has a timezone (ADR-0015).
function ledgerZone(deps: ChatImportDeps, ledger: Ledger): string {
  if (ledger.timezone === null) throw new Error(`ledger ${ledger.id} has no timezone`);
  return resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
}

// The message's sender as a user and a member of the ledger, provisioned on first sight in the
// ledger's timezone.
function senderUser(
  deps: ChatImportDeps,
  ledger: Ledger,
  message: Pick<StoredMessage, 'sender' | 'name'>,
  now: Date,
): UserId {
  const user = provisionUser(deps, {
    provider: 'telegram',
    externalId: String(message.sender),
    defaultTimezone: ledger.timezone ?? deps.defaultTimezone,
    defaultCurrency: deps.defaultCurrency,
    now,
  }).user;
  joinImportedMember(deps.db, {
    ledgerId: ledger.id,
    userId: user.id,
    displayName: message.name,
    joinedAt: now,
  });
  return user.id;
}

// Stores one item in the category suggestCategory picks (ADR-0008). Undefined when its source key
// was stored before.
function storeItem(
  deps: ChatImportDeps,
  input: {
    readonly ledger: Ledger;
    readonly createdBy: UserId;
    readonly item: ProposedItem;
    readonly at: Date;
    readonly sourceKey: string;
    readonly now: Date;
  },
): { readonly fallback: boolean } | undefined {
  const { ledger, item } = input;
  const key = descriptionKey(item.description);
  const category = suggestCategory({
    description: item.description,
    categories: listActiveCategories(deps.db, ledger.id),
    historyCategoryId: historyCategory(deps, ledger.id, key),
  });
  const stored = storeExpense(deps, {
    id: deps.newId() as ExpenseId,
    ledgerId: ledger.id,
    createdBy: input.createdBy,
    amountMinor: item.amountMinor,
    currency: item.currency,
    description: item.description,
    occurredAt: input.at,
    occurredOn: item.occurredOn,
    sourceKey: input.sourceKey,
    createdAt: input.now,
    category: { id: category.id, name: category.name },
    descriptionKey: key,
  });
  if (stored.kind !== 'stored' || !stored.created) return undefined;
  return { fallback: category.presetKey === FALLBACK_PRESET };
}

// Writes the payload back and moves the expiry to CHAT_IMPORT_TTL_MS from now.
function renew(deps: ChatImportDeps, row: ChatImportRow, payload: Payload, now: Date): void {
  updateChatImport(deps.db, row.userId, row.nonce, {
    payload: JSON.stringify(payload),
    expiresAt: new Date(now.getTime() + CHAT_IMPORT_TTL_MS),
  });
}

function storedMessage(message: ExportedMessage): StoredMessage {
  return {
    id: message.id,
    at: message.at.toISOString(),
    sender: message.senderTelegramId,
    name: message.senderName,
    text: message.text,
    forwarded: message.forwarded,
  };
}

function range(messages: readonly ExportedMessage[]): { first?: string; last?: string } {
  const instants = messages.map((message) => message.at.getTime()).sort((a, b) => a - b);
  const [first] = instants;
  const last = instants.at(-1);
  return first === undefined || last === undefined
    ? {}
    : { first: new Date(first).toISOString(), last: new Date(last).toISOString() };
}

// Each sender once, with the name of their latest message, most messages first; a tie keeps the
// order of first appearance.
function sendersOf(messages: readonly ExportedMessage[]): Sender[] {
  const senders = new Map<number, Sender>();
  for (const message of messages) {
    const seen = senders.get(message.senderTelegramId);
    senders.set(message.senderTelegramId, {
      telegramId: message.senderTelegramId,
      name: message.senderName ?? seen?.name ?? null,
      count: (seen?.count ?? 0) + 1,
    });
  }
  return [...senders.values()].sort((a, b) => b.count - a.count);
}

function parsePayload(text: string): Payload {
  return JSON.parse(text) as Payload;
}

// 6 base-36 characters from a fresh id.
function newNonce(newId: () => string): string {
  const digest = createHash('sha256').update(newId()).digest();
  return (digest.readUInt32BE(0) % 36 ** 6).toString(36).padStart(6, '0');
}

// Totals per currency, in order of first appearance.
function totalsOf(items: readonly Money[]): Money[] {
  const totals = new Map<CurrencyCode, number>();
  for (const { currency, amountMinor } of items) {
    totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
  }
  return [...totals].map(([currency, amountMinor]) => ({ amountMinor, currency }));
}
