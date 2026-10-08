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
import {
  countLiveExpensesByKeyPrefix,
  deleteExpensesByKeyPrefix,
  findTakenSourceKeys,
  type ExpenseId,
} from '../db/expenses.js';
import { findFirstLedgerChat } from '../db/ledgerChats.js';
import { findLedgerForMember, listMemberNames, type Ledger } from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import {
  isAmbiguousItem,
  readMessage,
  type MessageRead,
  type ProposedItem,
  type ReadItem,
  type ReviewReason,
} from '../domain/chatImport/readMessage.js';
import type { ExportedMessage, ExportRead } from '../domain/chatImport/telegramExport.js';
import type { CurrencyCode } from '../domain/currencies.js';
import {
  parseExpenseText,
  readTrailingExpense,
  type ExpenseTextResult,
} from '../domain/expenseText.js';
import type { Money } from '../domain/money.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { cancelFlowIf, completeFlow, startFlow, type ChatImportFixFlow } from './flowSessions.js';
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

// An export with more messages, or a preview proposing more items, is refused: the row and the
// review stay bounded. The file's own size cap is checked before download, in the handler.
export const CHAT_IMPORT_MAX_MESSAGES = 20_000;
export const CHAT_IMPORT_MAX_ITEMS = 3_000;

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
  // The ids of the messages to review as of the last preview, in order: the review cards.
  readonly queue?: readonly number[];
  // Per message id, the sender [👤] picked to pay, by Telegram id.
  readonly payers?: Readonly<Record<string, number>>;
  // Per message id, the items that replace the read ones: typed after [Исправить], or with an
  // ambiguous amount's reading picked.
  readonly fixes?: Readonly<Record<string, readonly ReadItem[]>>;
  // The distinct name prefixes of the messages not yet recorded or skipped, as of the last
  // upload, in order of first appearance and as first written: the questions.
  readonly prefixOrder?: readonly string[];
  // Per prefix, lowercased: what it was answered as.
  readonly prefixes?: Readonly<Record<string, PrefixAnswer>>;
}

// A name prefix answered as a sender (by Telegram id), as its message's own sender (`author`),
// or as no name (`notName`).
export type PrefixAnswer = number | 'author' | 'notName';

// The question about one name prefix, asked before the preview.
export interface PrefixQuestion {
  // The prefix's index in the import, which the answer buttons carry.
  readonly index: number;
  readonly prefix: string;
  // The messages starting with it, and the first of them.
  readonly count: number;
  readonly example: string;
  // 1-based, of `total` prefixes.
  readonly n: number;
  readonly total: number;
  // The export's named senders, most messages first, at most PREFIX_SENDER_BUTTONS; `index` is
  // the sender's in the import.
  readonly senders: readonly { readonly index: number; readonly name: string }[];
}

const PREFIX_SENDER_BUTTONS = 8;

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
  // A name prefix not answered yet: asked before the preview shows.
  readonly question?: PrefixQuestion;
}

export type PreviewResult =
  | ChatImportPreview
  // No binding for the export's chat, or one the user isn't a member of: the same answer.
  | { readonly kind: 'groupUnknown' }
  // Over CHAT_IMPORT_MAX_MESSAGES or CHAT_IMPORT_MAX_ITEMS: nothing is saved.
  | { readonly kind: 'tooManyMessages' }
  | { readonly kind: 'tooManyItems' };

// Reads the export against the group's ledger, saves it in the user's row under a new nonce and
// describes the preview. The binding's chat id is `-100<id>` for a supergroup or `-<id>` for a
// basic group; both are tried. Only messages sent before the binding are read. A new export of
// the chat the row already holds keeps the row's decisions and prefix answers; one of another
// chat replaces it.
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
  if (input.export.messages.length > CHAT_IMPORT_MAX_MESSAGES) {
    logger.info(
      { userId: user.id, messages: input.export.messages.length },
      'chat import too many messages',
    );
    return { kind: 'tooManyMessages' };
  }
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
  const fresh: Payload = {
    messages: before.filter((message) => /\d/.test(message.text)).map(storedMessage),
    noAmount: before.filter((message) => !/\d/.test(message.text)).length,
    ...range(before),
    senders: sendersOf(before),
    decisions: kept?.decisions ?? {},
    prefixes: kept?.prefixes ?? {},
  };
  const statuses = classify(deps, { ledger, chatId: binding.chatId, payload: fresh });
  const items = statuses.reduce(
    (sum, { status }) =>
      sum +
      (status.kind === 'ready'
        ? status.items.length
        : status.kind === 'review'
          ? status.read.items.length
          : 0),
    0,
  );
  if (items > CHAT_IMPORT_MAX_ITEMS) {
    logger.info({ userId: user.id, items }, 'chat import too many items');
    return { kind: 'tooManyItems' };
  }
  const payload = withQueue(deps, ledger, binding.chatId, {
    ...fresh,
    prefixOrder: prefixOrderOf(statuses),
  });
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
      // The messages still to review.
      readonly reviewCount: number;
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
    for (const entry of statuses) {
      const { message, status } = entry;
      const payer = payerOf(payload, entry);
      if (status.kind !== 'ready' || payer === undefined) continue;
      const sender = senderUser(deps, ledger, payer, now);
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
      reviewCount: statuses.filter(({ status }) => status.kind === 'review').length,
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

// An answer to a name prefix's question: stored in the row, and the next question or the preview.
// The prefix's messages then read without it, paid by the sender it names or by their own
// sender, unless it was answered as no name.
export function answerChatImportPrefix(
  deps: ChatImportDeps,
  input: {
    readonly user: User;
    readonly nonce: string;
    readonly prefixIndex: number;
    // A sender's index in the import, `author` or `notName`.
    readonly answer: number | 'author' | 'notName';
    readonly now: Date;
  },
): ChatImportPreview | { readonly kind: 'expired' } | { readonly kind: 'stale' } {
  const { user, now } = input;
  return deps.db.transaction(() => {
    const tap = held(deps, user, input.nonce, now);
    if (tap.kind !== 'held') return tap;
    const { row, ledger } = tap;
    const prefix = tap.payload.prefixOrder?.[input.prefixIndex];
    const answer =
      typeof input.answer === 'number'
        ? tap.payload.senders[input.answer]?.telegramId
        : input.answer;
    if (prefix === undefined || answer === undefined) return { kind: 'stale' } as const;
    const payload = withQueue(deps, ledger, row.chatId, {
      ...tap.payload,
      prefixes: { ...tap.payload.prefixes, [prefix.toLowerCase()]: answer },
    });
    renew(deps, row, payload, now);
    deps.logger.info({ userId: user.id }, 'chat import prefix answered');
    return describe(deps, { ledger, chatId: row.chatId, nonce: row.nonce, payload });
  })();
}

// The group's notice of an import: one silent message in the group, edited in place as the count
// grows and when the import is undone. It names the importer and counts; never an amount or a
// description.
export interface ChatImportNotice {
  readonly chatId: number;
  // Absent until the first recording posts it.
  readonly messageId: number | null;
  // The importer's name in the ledger; null when it has none.
  readonly importer: string | null;
  // The last message before the bot joined.
  readonly to: LocalDate;
  // The live expenses imported from the chat into the ledger.
  readonly count: number;
}

// The notice as it should read now; undefined once the row is gone or held no message.
export function chatImportNotice(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): ChatImportNotice | undefined {
  const tap = held(deps, input.user, input.nonce, input.now);
  return tap.kind === 'held' ? noticeOf(deps, tap) : undefined;
}

// Stores the posted notice's message id in the row holding `nonce`.
export function saveChatImportNotice(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly messageId: number },
): void {
  deps.db.transaction(() => {
    const row = findChatImport(deps.db, input.user.id);
    if (row?.nonce !== input.nonce) return;
    saveChatImport(deps.db, { ...row, noticeMessageId: input.messageId });
  })();
}

// [Отменить импорт]: how many expenses the undo would delete, for its confirm step.
export function chatImportUndoCount(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): { readonly kind: 'confirm'; readonly count: number } | Gone {
  const tap = held(deps, input.user, input.nonce, input.now);
  if (tap.kind !== 'held') return tap;
  renew(deps, tap.row, tap.payload, input.now);
  return {
    kind: 'confirm',
    count: countLiveExpensesByKeyPrefix(deps.db, tap.ledger.id, importKeyPrefix(tap.row.chatId)),
  };
}

export type UndoResult =
  | {
      readonly kind: 'undone';
      // The live expenses this tap deleted: 0 on a second tap.
      readonly count: number;
      readonly notice: ChatImportNotice | undefined;
    }
  | Gone;

// [Да, удалить]: deletes, in one transaction, every expense of the bound ledger whose source key
// is this chat's `tgx:<chatId>:`, for good (ADR-0047), and clears the row's recorded marks. The
// file is the backup: sent again, it records them again.
export function undoChatImport(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): UndoResult {
  const result = deps.db.transaction((): UndoResult => {
    const tap = held(deps, input.user, input.nonce, input.now);
    if (tap.kind !== 'held') return tap;
    const count = deleteExpensesByKeyPrefix(
      deps.db,
      tap.ledger.id,
      importKeyPrefix(tap.row.chatId),
    );
    const decisions = Object.fromEntries(
      Object.entries(tap.payload.decisions).filter(([, decision]) => decision !== 'recorded'),
    );
    const payload = withQueue(deps, tap.ledger, tap.row.chatId, { ...tap.payload, decisions });
    renew(deps, tap.row, payload, input.now);
    return { kind: 'undone', count, notice: noticeOf(deps, { ...tap, payload }) };
  })();
  if (result.kind === 'undone') {
    deps.logger.info({ userId: input.user.id, deleted: result.count }, 'chat import undone');
  }
  return result;
}

// The preview of the row as it stands: [Нет] on the undo's confirm step.
export function currentChatImportPreview(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): ChatImportPreview | Gone {
  const tap = held(deps, input.user, input.nonce, input.now);
  if (tap.kind !== 'held') return tap;
  renew(deps, tap.row, tap.payload, input.now);
  return describe(deps, {
    ledger: tap.ledger,
    chatId: tap.row.chatId,
    nonce: tap.row.nonce,
    payload: tap.payload,
  });
}

type Gone = { readonly kind: 'expired' } | { readonly kind: 'stale' };

function importKeyPrefix(chatId: string): string {
  return `tgx:${chatId}:`;
}

function noticeOf(deps: ChatImportDeps, tap: HeldImport): ChatImportNotice | undefined {
  if (tap.payload.last === undefined) return undefined;
  return {
    chatId: Number(tap.row.chatId),
    messageId: tap.row.noticeMessageId,
    importer: listMemberNames(deps.db, tap.ledger.id).get(tap.row.userId) ?? null,
    to: localDateOf(new Date(tap.payload.last), ledgerZone(deps, tap.ledger)),
    count: countLiveExpensesByKeyPrefix(deps.db, tap.ledger.id, importKeyPrefix(tap.row.chatId)),
  };
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

// A review card: one message to look at, what it proposes and who pays.
export interface ChatImportCard {
  readonly kind: 'card';
  readonly nonce: string;
  // The message's index in the import, which the card's buttons carry.
  readonly index: number;
  // 1-based, among the messages to review as of the last preview.
  readonly position: number;
  readonly total: number;
  // Null for a deleted account.
  readonly senderName: string | null;
  readonly date: LocalDate;
  readonly text: string;
  readonly reason: ReviewReason;
  // `total`: the stated total the items don't add up to.
  readonly stated?: Money;
  readonly items: readonly ReadItem[];
  // Absent for a deleted account's message until [👤] picks a payer.
  readonly payer?: { readonly name: string };
  // [Записать так]: there are items, none is ambiguous, and someone pays.
  readonly recordable: boolean;
}

// After the last card, or [Закончить проверку].
export interface ChatImportReviewDone {
  readonly kind: 'done';
  readonly nonce: string;
  // Of the messages to review: how many are recorded and how many skipped.
  readonly recorded: number;
  readonly skipped: number;
  // The ready items not yet recorded.
  readonly readyCount: number;
}

export type ChatImportReviewView = ChatImportCard | ChatImportReviewDone;

export type ReviewResult =
  ChatImportReviewView | { readonly kind: 'expired' } | { readonly kind: 'stale' };

type HeldImport = Omit<Extract<Held, { kind: 'held' }>, 'kind'>;

// A tap on a review card's message: the row, where every message stands, and this message.
interface CardTap extends HeldImport {
  readonly statuses: readonly Classified[];
  readonly entry: Classified;
  // 0-based in the queue; -1 for a message that isn't in it.
  readonly position: number;
}

// [Проверить (N)]: the first message still to review.
export function openChatImportReview(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): ReviewResult {
  return deps.db.transaction((): ReviewResult => {
    const tap = held(deps, input.user, input.nonce, input.now);
    if (tap.kind !== 'held') return tap;
    endFixPrompt(deps, input.user);
    renew(deps, tap.row, tap.payload, input.now);
    return reviewView(deps, tap, classifyHeld(deps, tap), 0);
  })();
}

// [« Назад к карточке], and any later tap on a card already decided: the card, or the next one
// still to review.
export function showChatImportCard(deps: ChatImportDeps, input: CardInput): ReviewResult {
  return deps.db.transaction((): ReviewResult => {
    const tap = cardTap(deps, input);
    if (tap.kind !== 'card') return tap;
    endFixPrompt(deps, input.user);
    renew(deps, tap.row, tap.payload, input.now);
    return reviewView(deps, tap, tap.statuses, Math.max(tap.position, 0));
  })();
}

// [Записать так]: the card's items under its payer, keyed by the message, and the next card. A
// card that can't be recorded as it stands comes back unchanged.
export function recordChatImportCard(deps: ChatImportDeps, input: CardInput): ReviewResult {
  return onOpenCard(deps, input, (tap, card) =>
    card.recordable ? recordCard(deps, tap, card, input.now) : card,
  );
}

// [Пропустить]: the message is marked skipped in the row, and the next card shows.
export function skipChatImportCard(deps: ChatImportDeps, input: CardInput): ReviewResult {
  return onOpenCard(deps, input, (tap) => {
    const payload = decide(tap, 'skipped');
    renew(deps, tap.row, payload, input.now);
    deps.logger.info({ userId: input.user.id }, 'chat import card skipped');
    return reviewView(
      deps,
      { ...tap, payload },
      classifyHeld(deps, { ...tap, payload }),
      tap.position + 1,
    );
  });
}

// [👤]: the payer moves to the next of the export's named senders, most messages first.
export function cycleChatImportPayer(deps: ChatImportDeps, input: CardInput): ReviewResult {
  return onOpenCard(deps, input, (tap, card) => {
    const named = tap.payload.senders.filter((sender) => sender.name !== null);
    const current = payerOf(tap.payload, tap.entry)?.sender;
    const at = named.findIndex((sender) => sender.telegramId === current);
    const next = named[(at + 1) % named.length];
    if (next === undefined) return card;
    const payload: Payload = {
      ...tap.payload,
      payers: { ...tap.payload.payers, [String(tap.entry.message.id)]: next.telegramId },
    };
    renew(deps, tap.row, payload, input.now);
    return cardOf(deps, { ...tap, payload }, tap.entry, tap.position);
  });
}

// A reading button: the card's first ambiguous item takes reading `reading` (ADR-0004). With no
// ambiguous item left and a payer, the card records; otherwise it shows again.
export function pickChatImportReading(
  deps: ChatImportDeps,
  input: CardInput & { readonly reading: number },
): ReviewResult {
  return onOpenCard(deps, input, (tap, card) => {
    const at = card.items.findIndex(isAmbiguousItem);
    const ambiguous = card.items[at];
    if (ambiguous === undefined || !isAmbiguousItem(ambiguous)) return card;
    const reading = ambiguous.readings[input.reading];
    if (reading === undefined) return card;
    const items = card.items.map((item, i): ReadItem =>
      i === at
        ? {
            amountMinor: reading.amountMinor,
            currency: ambiguous.currency,
            description: ambiguous.description,
            occurredOn: ambiguous.occurredOn,
          }
        : item,
    );
    const payload = fixed(tap, items);
    renew(deps, tap.row, payload, input.now);
    const next = cardOf(deps, { ...tap, payload }, tap.entry, tap.position);
    return next.recordable ? recordCard(deps, { ...tap, payload }, next, input.now) : next;
  });
}

export type FixStartResult = { readonly kind: 'prompt' } | ReviewResult;

// [Исправить]: the next text is claimed as the card's items, through the pending-flow slot
// (ADR-0009). The card at `chatId`/`messageId` shows the prompt meanwhile.
export function startChatImportFix(
  deps: ChatImportDeps,
  input: CardInput & { readonly chatId: number; readonly messageId: number },
): FixStartResult {
  return onOpenCard(deps, input, (tap): FixStartResult => {
    renew(deps, tap.row, tap.payload, input.now);
    startFlow(
      deps,
      input.user,
      {
        kind: 'chatImportFix',
        nonce: input.nonce,
        index: input.index,
        chatId: input.chatId,
        messageId: input.messageId,
      },
      input.now,
    );
    return { kind: 'prompt' };
  });
}

export type FixAnswerResult =
  | ReviewResult
  // Line `n` (1-based, empty lines not counted) didn't read; the prompt stays.
  | { readonly kind: 'badLine'; readonly n: number; readonly line: string };

// The typed answer to [Исправить]: each non-empty line reads amount-first (parseExpenseText),
// then amount-last (readTrailingExpense), dated from the message's day. Every line must read, or
// nothing changes and the prompt stays. Read, the items replace the card's and the card shows
// again.
export function answerChatImportFix(
  deps: ChatImportDeps,
  input: {
    readonly user: User;
    readonly flow: ChatImportFixFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): FixAnswerResult {
  const { user, flow, now } = input;
  return deps.db.transaction((): FixAnswerResult => {
    const tap = cardTap(deps, { user, nonce: flow.nonce, index: flow.index, now });
    if (tap.kind !== 'card') {
      endFixPrompt(deps, user);
      return tap;
    }
    if (tap.entry.status.kind !== 'review') {
      completeFlow(deps, user, input.inputKey);
      return reviewView(deps, tap, tap.statuses, Math.max(tap.position, 0));
    }
    const today = localDateOf(new Date(tap.entry.message.at), ledgerZone(deps, tap.ledger));
    const lines = input.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const items: ProposedItem[] = [];
    for (const [i, line] of lines.entries()) {
      const item = readFixLine(line, tap.ledger.defaultCurrency, today);
      if (item === undefined) return { kind: 'badLine', n: i + 1, line };
      items.push(item);
    }
    const payload = fixed(tap, items);
    renew(deps, tap.row, payload, now);
    completeFlow(deps, user, input.inputKey);
    return cardOf(deps, { ...tap, payload }, tap.entry, tap.position);
  })();
}

// [Закончить проверку]: the summary, whatever is left to review.
export function finishChatImportReview(
  deps: ChatImportDeps,
  input: { readonly user: User; readonly nonce: string; readonly now: Date },
): ReviewResult {
  return deps.db.transaction((): ReviewResult => {
    const tap = held(deps, input.user, input.nonce, input.now);
    if (tap.kind !== 'held') return tap;
    endFixPrompt(deps, input.user);
    renew(deps, tap.row, tap.payload, input.now);
    return reviewDone(tap, classifyHeld(deps, tap));
  })();
}

interface CardInput {
  readonly user: User;
  readonly nonce: string;
  readonly index: number;
  readonly now: Date;
}

function cardTap(
  deps: ChatImportDeps,
  input: CardInput,
):
  | (CardTap & { readonly kind: 'card' })
  | { readonly kind: 'expired' }
  | { readonly kind: 'stale' } {
  const tap = held(deps, input.user, input.nonce, input.now);
  if (tap.kind !== 'held') return tap;
  const statuses = classifyHeld(deps, tap);
  const entry = statuses[input.index];
  if (entry === undefined) return { kind: 'stale' };
  const position = (tap.payload.queue ?? []).indexOf(entry.message.id);
  return {
    kind: 'card',
    row: tap.row,
    ledger: tap.ledger,
    payload: tap.payload,
    statuses,
    entry,
    position,
  };
}

// Runs `act` on a card still to review, ending any [Исправить] prompt first, in one transaction.
// A card already recorded or skipped answers with itself or the next card still to review, so a
// double tap does nothing twice.
function onOpenCard<T>(
  deps: ChatImportDeps,
  input: CardInput,
  act: (tap: CardTap, card: ChatImportCard) => T | ReviewResult,
): T | ReviewResult {
  return deps.db.transaction((): T | ReviewResult => {
    const tap = cardTap(deps, input);
    if (tap.kind !== 'card') return tap;
    endFixPrompt(deps, input.user);
    if (tap.entry.status.kind !== 'review') {
      return reviewView(deps, tap, tap.statuses, Math.max(tap.position, 0));
    }
    return act(tap, cardOf(deps, tap, tap.entry, tap.position));
  })();
}

function endFixPrompt(deps: ChatImportDeps, user: User): void {
  cancelFlowIf(deps, user, (flow) => flow.kind === 'chatImportFix');
}

function recordCard(
  deps: ChatImportDeps,
  tap: CardTap,
  card: ChatImportCard,
  now: Date,
): ChatImportReviewView {
  const { message } = tap.entry;
  const payer = payerOf(tap.payload, tap.entry);
  if (payer === undefined) return card;
  const createdBy = senderUser(deps, tap.ledger, payer, now);
  let count = 0;
  for (const [index, item] of card.items.entries()) {
    if (isAmbiguousItem(item)) continue;
    const stored = storeItem(deps, {
      ledger: tap.ledger,
      createdBy,
      item,
      at: new Date(message.at),
      sourceKey: importSourceKey(tap.row.chatId, message.id, index),
      now,
    });
    if (stored !== undefined) count += 1;
  }
  const payload = decide(tap, 'recorded');
  renew(deps, tap.row, payload, now);
  deps.logger.info(
    { userId: tap.row.userId, ledgerId: tap.ledger.id, recorded: count },
    'chat import card recorded',
  );
  const after = { ...tap, payload };
  return reviewView(deps, after, classifyHeld(deps, after), tap.position + 1);
}

// The first message still to review from queue position `from` on, or the summary.
function reviewView(
  deps: ChatImportDeps,
  tap: HeldImport,
  statuses: readonly Classified[],
  from: number,
): ChatImportReviewView {
  const queue = tap.payload.queue ?? [];
  const byId = new Map(statuses.map((entry) => [entry.message.id, entry]));
  for (let position = from; position < queue.length; position += 1) {
    const entry = byId.get(queue[position] ?? -1);
    if (entry?.status.kind === 'review') return cardOf(deps, tap, entry, position);
  }
  return reviewDone(tap, statuses);
}

function reviewDone(tap: HeldImport, statuses: readonly Classified[]): ChatImportReviewDone {
  const queued = new Set(tap.payload.queue ?? []);
  const inQueue = statuses.filter((entry) => queued.has(entry.message.id));
  return {
    kind: 'done',
    nonce: tap.row.nonce,
    recorded: inQueue.filter(({ status }) => status.kind === 'already').length,
    skipped: inQueue.filter(({ status }) => status.kind === 'skipped').length,
    readyCount: statuses.reduce(
      (sum, { status }) => sum + (status.kind === 'ready' ? status.items.length : 0),
      0,
    ),
  };
}

function cardOf(
  deps: ChatImportDeps,
  tap: HeldImport,
  entry: Classified,
  position: number,
): ChatImportCard {
  const { message, status } = entry;
  if (status.kind !== 'review') throw new Error(`message ${message.id} is not to review`);
  const { read } = status;
  const items = tap.payload.fixes?.[String(message.id)] ?? read.items;
  const payer = payerOf(tap.payload, entry);
  return {
    kind: 'card',
    nonce: tap.row.nonce,
    index: entry.index,
    position: position + 1,
    total: tap.payload.queue?.length ?? 0,
    senderName: message.name,
    date: localDateOf(new Date(message.at), ledgerZone(deps, tap.ledger)),
    text: message.text,
    reason: read.reason,
    ...(read.stated === undefined ? {} : { stated: read.stated }),
    items,
    ...(payer === undefined ? {} : { payer: { name: payer.name } }),
    recordable: items.length > 0 && !items.some(isAmbiguousItem) && payer !== undefined,
  };
}

// Who pays for the message, by Telegram id and name: [👤]'s pick, else the sender its name prefix
// was answered as, else its own sender. None for a deleted account's message until one is picked.
function payerOf(
  payload: Payload,
  entry: Classified,
): { readonly sender: number; readonly name: string } | undefined {
  const { message } = entry;
  const picked = payload.payers?.[String(message.id)] ?? entry.prefixPayer;
  const payer = picked ?? message.sender;
  const name =
    payer === message.sender && message.name !== null
      ? message.name
      : picked === undefined
        ? null
        : (payload.senders.find((sender) => sender.telegramId === payer)?.name ?? null);
  return name === null ? undefined : { sender: payer, name };
}

function decide(tap: CardTap, decision: Decision): Payload {
  return {
    ...tap.payload,
    decisions: { ...tap.payload.decisions, [String(tap.entry.message.id)]: decision },
  };
}

function fixed(tap: CardTap, items: readonly ReadItem[]): Payload {
  return { ...tap.payload, fixes: { ...tap.payload.fixes, [String(tap.entry.message.id)]: items } };
}

function readFixLine(
  line: string,
  currency: CurrencyCode,
  today: LocalDate,
): ProposedItem | undefined {
  const leading = parseExpenseText(line, currency, today);
  const parsed: ExpenseTextResult =
    leading.kind === 'notExpense' ? readTrailingExpense(line, currency, today) : leading;
  if (parsed.kind !== 'expense' || parsed.split !== undefined) return undefined;
  return {
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    description: parsed.description,
    occurredOn: parsed.date ?? today,
  };
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
  // The message's index in the payload.
  readonly index: number;
  readonly status: Status;
  // The name prefix the message starts with, as written; read only for a message not yet
  // recorded or skipped.
  readonly prefix?: string;
  // The sender the prefix was answered as, by Telegram id.
  readonly prefixPayer?: number;
}

function classifyHeld(deps: ChatImportDeps, tap: HeldImport): Classified[] {
  return classify(deps, { ledger: tap.ledger, chatId: tap.row.chatId, payload: tap.payload });
}

// The payload with its queue: the messages to review now, in order.
function withQueue(
  deps: ChatImportDeps,
  ledger: Ledger,
  chatId: string,
  payload: Payload,
): Payload {
  const statuses = classify(deps, { ledger, chatId, payload });
  return {
    ...payload,
    queue: statuses
      .filter(({ status }) => status.kind === 'review')
      .map(({ message }) => message.id),
  };
}

// The distinct name prefixes, by their lowercased form, in order of first appearance.
function prefixOrderOf(statuses: readonly Classified[]): string[] {
  const seen = new Map<string, string>();
  for (const { prefix } of statuses) {
    if (prefix !== undefined && !seen.has(prefix.toLowerCase())) {
      seen.set(prefix.toLowerCase(), prefix);
    }
  }
  return [...seen.values()];
}

// The first prefix of the row not answered yet, as a question.
function prefixQuestion(
  payload: Payload,
  statuses: readonly Classified[],
): PrefixQuestion | undefined {
  const order = payload.prefixOrder ?? [];
  const index = order.findIndex((prefix) => payload.prefixes?.[prefix.toLowerCase()] === undefined);
  const prefix = order[index];
  if (prefix === undefined) return undefined;
  const messages = statuses.filter((entry) => entry.prefix?.toLowerCase() === prefix.toLowerCase());
  return {
    index,
    prefix,
    count: messages.length,
    example: messages[0]?.message.text ?? '',
    n: index + 1,
    total: order.length,
    senders: payload.senders
      .flatMap((sender, i) => (sender.name === null ? [] : [{ index: i, name: sender.name }]))
      .slice(0, PREFIX_SENDER_BUTTONS),
  };
}

// Where each kept message stands: recorded (its first item's key is stored, by this import or an
// earlier one), skipped in this row, ready or to review. A message whose name prefix was answered
// as a name reads without it: paid by the sender it names, or by its own sender for `author`.
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
  return payload.messages.map((message, index): Classified => {
    if (taken.has(importSourceKey(chatId, message.id, 0))) {
      return { message, index, status: { kind: 'already' } };
    }
    if (payload.decisions[String(message.id)] === 'skipped') {
      return { message, index, status: { kind: 'skipped' } };
    }
    const today = localDateOf(new Date(message.at), timezone);
    const context = { forwarded: message.forwarded, deletedSender: message.name === null };
    const first = readMessage(message.text, ledger.defaultCurrency, today, context);
    const prefix = first.verdict === 'review' ? first.prefix : undefined;
    const answer = prefix === undefined ? undefined : payload.prefixes?.[prefix.toLowerCase()];
    const read =
      answer === undefined || answer === 'notName'
        ? first
        : readMessage(message.text, ledger.defaultCurrency, today, {
            ...context,
            prefixAnswered: true,
            ...(typeof answer === 'number' ? { deletedSender: false } : {}),
          });
    const named = {
      message,
      index,
      ...(prefix === undefined ? {} : { prefix }),
      ...(typeof answer === 'number' ? { prefixPayer: answer } : {}),
    };
    // A message is kept only with a digit in it, so noAmount doesn't come back.
    if (read.verdict === 'review') return { ...named, status: { kind: 'review', read } };
    if (read.verdict === 'ready') return { ...named, status: { kind: 'ready', items: read.items } };
    return {
      ...named,
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
  const ready = statuses.flatMap((entry) =>
    entry.status.kind === 'ready'
      ? entry.status.items.map((item) => ({
          ...item,
          messageId: entry.message.id,
          senderName: payerOf(payload, entry)?.name ?? null,
        }))
      : [],
  );
  const question = prefixQuestion(payload, statuses);
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
    ...(question === undefined ? {} : { question }),
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
