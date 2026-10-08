import type { CurrencyCode } from '../domain/currencies.js';
import { chatterShaped, parseExpenseText, readTrailingExpense } from '../domain/expenseText.js';
import type { Money } from '../domain/money.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { findExpenseBySourceKey } from '../db/expenses.js';
import {
  deleteGroupAsk,
  findGroupAsk,
  insertGroupAsk,
  listGroupAsksCreatedBy,
  type GroupAsk,
} from '../db/groupAsks.js';
import {
  findLedgerChat,
  insertLedgerChat,
  moveLedgerChat,
  setLedgerChatActive,
} from '../db/ledgerChats.js';
import {
  findLedgerById,
  findPersonalLedger,
  insertLedger,
  insertMember,
  joinMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { provisionUser } from './provisionUser.js';
import {
  recordExpense,
  resolveLedgerTimezone,
  type RecordDeps,
  type RecordExpenseResult,
} from './recordExpense.js';
import { seedLedgerCategories } from './seedCategories.js';
import { resolveUserTimezone } from './settings.js';

// Group chats bound to shared ledgers (ADR-0014): binding a group when an admitted user adds
// the bot, and recording a member's message into the bound ledger. The sender's active ledger is
// neither read nor changed here.

export interface GroupDeps extends RecordDeps {
  readonly defaultCurrency: CurrencyCode;
}

// A Telegram account as a group update shows it.
export interface GroupSender {
  readonly telegramId: number;
  readonly firstName: string;
}

function chatKey(chatId: number): string {
  return String(chatId);
}

function ensureSender(deps: GroupDeps, sender: GroupSender, timezone: string, now: Date): User {
  return provisionUser(deps, {
    provider: 'telegram',
    externalId: String(sender.telegramId),
    defaultTimezone: timezone,
    defaultCurrency: deps.defaultCurrency,
    now,
  }).user;
}

export type BindResult = {
  readonly kind: 'bound';
  readonly ledger: Ledger;
  readonly created: boolean;
  // An inactive binding (the bot was removed) turned back on: the same ledger, nothing new.
  readonly reactivated: boolean;
};

// Binds the chat to a new shared ledger named after it, owned by the adder: the adder's personal
// currency and timezone, the preset categories, and an active binding. The caller has checked
// that the adder is admitted. A chat bound before returns its ledger, reactivating the
// binding if the bot had been removed, and creates nothing.
export function bindGroup(
  deps: GroupDeps,
  input: {
    readonly chatId: number;
    readonly title: string;
    readonly adder: GroupSender;
    readonly now: Date;
  },
): BindResult {
  const { db, logger, newId } = deps;
  const { now } = input;
  return db.transaction((): BindResult => {
    const existing = findLedgerChat(db, 'telegram', chatKey(input.chatId));
    if (existing !== undefined) {
      const ledger = findLedgerById(db, existing.ledgerId);
      if (ledger === undefined) throw new Error(`binding to a missing ledger ${existing.ledgerId}`);
      const reactivated = setLedgerChatActive(db, 'telegram', chatKey(input.chatId), true);
      if (reactivated) logger.info({ ledgerId: ledger.id }, 'group binding reactivated');
      return { kind: 'bound', ledger, created: false, reactivated };
    }
    const adder = ensureSender(deps, input.adder, deps.defaultTimezone, now);
    const personal = findPersonalLedger(db, adder.id);
    if (personal === undefined) throw new Error(`user ${adder.id} has no personal ledger`);
    const ledger: Ledger = {
      id: newId() as LedgerId,
      kind: 'shared',
      name: input.title,
      defaultCurrency: personal.defaultCurrency,
      timezone: resolveUserTimezone(deps, adder),
    };
    insertLedger(db, { ...ledger, ownerUserId: adder.id, createdAt: now });
    insertMember(db, {
      ledgerId: ledger.id,
      userId: adder.id,
      role: 'owner',
      displayName: input.adder.firstName,
    });
    seedLedgerCategories(db, ledger.id, now);
    insertLedgerChat(db, {
      provider: 'telegram',
      chatId: chatKey(input.chatId),
      ledgerId: ledger.id,
      active: true,
      boundBy: adder.id,
      boundAt: now,
    });
    logger.info({ ledgerId: ledger.id, userId: adder.id }, 'group bound to a new shared ledger');
    return { kind: 'bound', ledger, created: true, reactivated: false };
  })();
}

// The bot left or was removed: the binding goes inactive, and the ledger and its expenses stay.
// Returns false when the chat had no active binding.
export function unbindGroup({ db, logger }: GroupDeps, chatId: number): boolean {
  const changed = setLedgerChatActive(db, 'telegram', chatKey(chatId), false);
  if (changed) logger.info('group binding deactivated');
  return changed;
}

// A group upgraded to a supergroup gets a new chat id; its binding moves with it. Telegram
// reports the move in both chats, so a second report finds nothing to move.
export function migrateGroup(
  { db, logger }: GroupDeps,
  input: { readonly from: number; readonly to: number },
): boolean {
  const moved = moveLedgerChat(db, 'telegram', chatKey(input.from), chatKey(input.to));
  if (moved) logger.info('group binding moved to a new chat id');
  return moved;
}

// The ledger an active binding routes the chat to; undefined for an unbound or inactive chat.
export function boundLedger({ db }: Pick<GroupDeps, 'db'>, chatId: number): Ledger | undefined {
  const binding = findLedgerChat(db, 'telegram', chatKey(chatId));
  if (binding === undefined || !binding.active) return undefined;
  return findLedgerById(db, binding.ledgerId);
}

export type GroupRecordResult =
  // `sentOn`: the ledger's local date of the message.
  | (Extract<RecordExpenseResult, { kind: 'recorded' }> & { readonly sentOn: LocalDate })
  // Unbound chat, or text that doesn't record an expense as it stands: nothing is stored.
  | { readonly kind: 'ignored' };

// A group message into the bound ledger. Only text that parses as an expense provisions the
// sender (user, identity, personal ledger) and makes them a `member`; anything else stores
// nothing. Dated in the ledger's timezone (ADR-0015).
export function recordGroupExpense(
  deps: GroupDeps,
  input: {
    readonly chatId: number;
    readonly sender: GroupSender;
    readonly text: string;
    readonly sourceKey: string;
    readonly occurredAt: Date;
    readonly now: Date;
    // `any` also records amount-last text: an answered question (ADR-0046).
    readonly forms?: 'leading' | 'any';
  },
): GroupRecordResult {
  const { db } = deps;
  const ledger = boundLedger(deps, input.chatId);
  if (ledger === undefined || ledger.timezone === null) return { kind: 'ignored' };
  const timezone = resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  const sentOn = localDateOf(input.occurredAt, timezone);
  const leading = parseExpenseText(input.text, ledger.defaultCurrency, sentOn);
  const parsed =
    leading.kind === 'notExpense' && input.forms === 'any'
      ? readTrailingExpense(input.text, ledger.defaultCurrency, sentOn)
      : leading;
  if (parsed.kind !== 'expense') return { kind: 'ignored' };
  return db.transaction((): GroupRecordResult => {
    const user = ensureSender(deps, input.sender, timezone, input.now);
    joinMember(db, {
      ledgerId: ledger.id,
      userId: user.id,
      displayName: input.sender.firstName,
      joinedAt: input.now,
    });
    const result = recordExpense(deps, {
      user,
      target: { kind: 'ledger', ledgerId: ledger.id },
      text: input.text,
      sourceKey: input.sourceKey,
      occurredAt: input.occurredAt,
      now: input.now,
      ...(input.forms === undefined ? {} : { forms: input.forms }),
    });
    return result.kind === 'recorded' ? { ...result, sentOn } : { kind: 'ignored' };
  })();
}

// An amount-last group message (ADR-0046) is asked about before it records. The question
// expires this long after it is asked.
export const GROUP_ASK_TTL_MS = 15 * 60 * 1000;

export interface GroupAskOffer {
  readonly ledger: Ledger;
  readonly money: Money;
  readonly description: string;
  // The expense's date, and the ledger's local date of the message.
  readonly date: LocalDate;
  readonly sentOn: LocalDate;
}

// The question to ask about a group message, or undefined for none: an unbound chat, text that
// reads amount-first (recordGroupExpense's), text that doesn't read amount-last as a plain
// expense (ambiguous, future-dated, too many tags, invalid), chatter («буду в 7»), and a message
// already asked about or recorded. Reads only.
export function groupAskFor(
  deps: GroupDeps,
  input: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text: string;
    readonly occurredAt: Date;
  },
): GroupAskOffer | undefined {
  const { db } = deps;
  const ledger = boundLedger(deps, input.chatId);
  if (ledger === undefined || ledger.timezone === null) return undefined;
  const timezone = resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  const sentOn = localDateOf(input.occurredAt, timezone);
  if (parseExpenseText(input.text, ledger.defaultCurrency, sentOn).kind !== 'notExpense') {
    return undefined;
  }
  const parsed = readTrailingExpense(input.text, ledger.defaultCurrency, sentOn);
  if (parsed.kind !== 'expense' || chatterShaped(input.text, sentOn)) return undefined;
  if (findGroupAsk(db, chatKey(input.chatId), input.messageId) !== undefined) return undefined;
  if (findExpenseBySourceKey(db, groupSourceKey(input.chatId, input.messageId)) !== undefined) {
    return undefined;
  }
  return {
    ledger,
    money: { amountMinor: parsed.amountMinor, currency: parsed.currency },
    description: parsed.description,
    date: parsed.date ?? sentOn,
    sentOn,
  };
}

// Stores the question once it is sent. False when the message already had one.
export function saveGroupAsk(
  { db, logger }: GroupDeps,
  input: {
    readonly chatId: number;
    readonly messageId: number;
    readonly ledgerId: LedgerId;
    readonly senderTelegramId: number;
    readonly text: string;
    readonly sentAt: Date;
    readonly askMessageId: number;
    readonly now: Date;
  },
): boolean {
  const saved = insertGroupAsk(db, {
    chatId: chatKey(input.chatId),
    messageId: input.messageId,
    ledgerId: input.ledgerId,
    senderTelegramId: String(input.senderTelegramId),
    text: input.text,
    sentAt: input.sentAt,
    askMessageId: input.askMessageId,
    createdAt: input.now,
  });
  if (saved) logger.info({ ledgerId: input.ledgerId }, 'group expense asked');
  return saved;
}

export type GroupAskAnswer =
  | {
      readonly kind: 'recorded';
      readonly recorded: Extract<GroupRecordResult, { kind: 'recorded' }>;
    }
  | { readonly kind: 'dismissed' }
  // The tapper is not the message's sender: nothing changes.
  | { readonly kind: 'notSender' }
  // No question, and the message's expense exists: a second tap, or a redelivered one.
  | { readonly kind: 'alreadyRecorded' }
  // No question and no expense: it expired, or was dismissed.
  | { readonly kind: 'gone' };

// The sender's answer to a question. Deleting the row claims it, in the transaction that
// records, so a second tap finds no row. [Записать] records the message's own text under its
// source key, dated by the message.
export function answerGroupAsk(
  deps: GroupDeps,
  input: {
    readonly chatId: number;
    readonly messageId: number;
    readonly tapper: GroupSender;
    readonly answer: 'record' | 'dismiss';
    readonly now: Date;
  },
): GroupAskAnswer {
  const { db, logger } = deps;
  const sourceKey = groupSourceKey(input.chatId, input.messageId);
  return db.transaction((): GroupAskAnswer => {
    const ask = findGroupAsk(db, chatKey(input.chatId), input.messageId);
    if (ask === undefined) {
      return findExpenseBySourceKey(db, sourceKey) === undefined
        ? { kind: 'gone' }
        : { kind: 'alreadyRecorded' };
    }
    if (ask.senderTelegramId !== String(input.tapper.telegramId)) return { kind: 'notSender' };
    deleteGroupAsk(db, ask.chatId, ask.messageId);
    if (input.answer === 'dismiss') {
      logger.info({ ledgerId: ask.ledgerId }, 'group ask dismissed');
      return { kind: 'dismissed' };
    }
    const recorded = recordGroupExpense(deps, {
      chatId: input.chatId,
      sender: input.tapper,
      text: ask.text,
      sourceKey,
      occurredAt: ask.sentAt,
      now: input.now,
      forms: 'any',
    });
    return recorded.kind === 'recorded' ? { kind: 'recorded', recorded } : { kind: 'gone' };
  })();
}

// The questions whose time ran out by `now`.
export function dueGroupAsks({ db }: Pick<GroupDeps, 'db'>, now: Date): GroupAsk[] {
  return listGroupAsksCreatedBy(db, new Date(now.getTime() - GROUP_ASK_TTL_MS));
}

// Claims an expired question: true when this call deleted its row, so the caller deletes the
// question message once.
export function expireGroupAsk(
  { db, logger }: Pick<GroupDeps, 'db' | 'logger'>,
  ask: Pick<GroupAsk, 'chatId' | 'messageId' | 'ledgerId'>,
): boolean {
  const claimed = db.transaction(() => deleteGroupAsk(db, ask.chatId, ask.messageId))();
  if (claimed) logger.info({ ledgerId: ask.ledgerId }, 'group ask expired');
  return claimed;
}

// The source key of a group message, the same as recordGroupExpense's callers build.
function groupSourceKey(chatId: number, messageId: number): string {
  return `tg:${chatId}:${messageId}`;
}
