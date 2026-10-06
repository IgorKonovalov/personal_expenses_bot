import type { CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
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
  },
): GroupRecordResult {
  const { db } = deps;
  const ledger = boundLedger(deps, input.chatId);
  if (ledger === undefined || ledger.timezone === null) return { kind: 'ignored' };
  const timezone = resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  const sentOn = localDateOf(input.occurredAt, timezone);
  if (parseExpenseText(input.text, ledger.defaultCurrency, sentOn).kind !== 'expense') {
    return { kind: 'ignored' };
  }
  return db.transaction((): GroupRecordResult => {
    const user = ensureSender(deps, input.sender, timezone, input.now);
    joinMember(db, { ledgerId: ledger.id, userId: user.id, displayName: input.sender.firstName });
    const result = recordExpense(deps, {
      user,
      target: { kind: 'ledger', ledgerId: ledger.id },
      text: input.text,
      sourceKey: input.sourceKey,
      occurredAt: input.occurredAt,
      now: input.now,
    });
    return result.kind === 'recorded' ? { ...result, sentOn } : { kind: 'ignored' };
  })();
}
