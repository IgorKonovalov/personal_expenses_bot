import { findCategory, listActiveCategories, type CategoryId } from '../db/categories.js';
import {
  findExpenseById,
  findExpenseBySourceKey,
  findHistoryCategory,
  insertExpenseOrGetExisting,
  insertSealedExpenseOrGetExisting,
  isSealed,
  restoreDeletedExpense,
  softDeleteExpense,
  type Expense,
  type ExpenseCategory,
  type ExpenseId,
  type NewExpense,
  type StoredExpense,
} from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import { findUserByIdentity, type User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { splitShares } from '../domain/debts.js';
import { parseExpenseText, type ExpenseTextResult } from '../domain/expenseText.js';
import type { AmountReading } from '../domain/money.js';
import { MAX_TAGS_PER_EXPENSE } from '../domain/tags.js';
import { localDateOf } from '../domain/time.js';
import { resolveTimezone } from '../domain/timezones.js';
import type { Logger } from '../logger.js';
import {
  isSealedLedger,
  openExpenses,
  isLocked,
  openExpense,
  sealPayload,
  sealingKey,
  type KeyDeps,
  type Locked,
} from './ledgerKeys.js';
import type { ServiceDeps } from './provisionUser.js';
import { resolveUserTimezone } from './settings.js';
import { stickyTagOf, withStickyTag } from './stickyTag.js';

export interface RecordDeps extends ServiceDeps {
  readonly logger: Logger;
  // The fallback for a stored timezone the runtime doesn't know.
  readonly defaultTimezone: string;
}

// Where an expense goes: the sender's active ledger in DM (ADR-0002), the chat's bound ledger in
// a group (ADR-0014).
export type RecordTarget =
  { readonly kind: 'active' } | { readonly kind: 'ledger'; readonly ledgerId: LedgerId };

// The zone a ledger's dates and periods are computed in: the ledger's own, else the user's
// (ADR-0015). A stored zone Intl rejects falls back to the default with a warn log of ids only.
export function effectiveTimezone(
  deps: Pick<RecordDeps, 'logger' | 'defaultTimezone'>,
  user: User,
  ledger: Ledger,
): string {
  return ledger.timezone === null
    ? resolveUserTimezone(deps, user)
    : resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
}

// A shared ledger's own zone, with the same fallback as a user's.
export function resolveLedgerTimezone(
  { logger, defaultTimezone }: Pick<RecordDeps, 'logger' | 'defaultTimezone'>,
  ledger: { readonly id: LedgerId; readonly timezone: string },
): string {
  const { tz, fellBack } = resolveTimezone(ledger.timezone, defaultTimezone);
  if (fellBack)
    logger.warn({ ledgerId: ledger.id }, 'stored ledger timezone is invalid, using the default');
  return tz;
}

export interface RecordExpenseInput {
  readonly user: User;
  // The active ledger when omitted. A `ledger` target must have the user as a member.
  readonly target?: RecordTarget;
  readonly text: string;
  // Opaque dedupe key built by the adapter, e.g. `tg:<chat_id>:<message_id>`.
  readonly sourceKey: string;
  // When the user sent it (the Telegram message date), not when it is processed.
  readonly occurredAt: Date;
  readonly now: Date;
  // The user's answer to an ambiguous amount: records that reading of the same text.
  readonly reading?: AmountReading['interpretation'];
}

export interface SplitRecorded {
  readonly whole: number;
  readonly parts: number;
  // The user's own share, recorded as the expense.
  readonly share: number;
  // What each of the other parts - 1 people owes.
  readonly each: number;
}

export type RecordExpenseResult =
  | {
      readonly kind: 'recorded';
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly duplicate: boolean;
      // The expense sits in the ledger's fallback category («Другое»): nothing recognised it.
      readonly fallbackCategory: boolean;
      // A `/N` text, recorded at the user's share: the whole, the parts, and each other part.
      readonly split?: SplitRecorded;
    }
  // A `/N` text aimed at a shared ledger; nothing is recorded.
  | { readonly kind: 'splitInGroup' }
  | {
      readonly kind: 'ambiguous';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
      readonly description: string;
      readonly ledger: Ledger;
    }
  // A redelivery of an expense in a sealed ledger that is locked (ADR-0020): it stays recorded,
  // and nothing about it can be shown.
  | { readonly kind: 'sealedDuplicate' }
  | { readonly kind: 'invalid' }
  // More than MAX_TAGS_PER_EXPENSE distinct tags; nothing is recorded.
  | { readonly kind: 'tooManyTags' }
  // The text names a date after today; nothing is recorded.
  | { readonly kind: 'futureDate' }
  | { readonly kind: 'notExpense' }
  // A reading was chosen, but the text no longer offers it.
  | { readonly kind: 'readingUnavailable' };

// Records free text into the target ledger, in the category suggestCategory picks (ADR-0008),
// dated in the ledger's effective timezone. A source key seen before returns the stored expense
// unchanged, so a redelivered update, or a second tap on a reading, records nothing new.
// In a sealed ledger (ADR-0020) the amount, description and category are sealed to the ledger's
// public key, so recording needs no unlock; the suggestion skips the history step, whose key
// sealed rows don't store. Without a keyring every sealed ledger reads as locked.
export function recordExpense(
  deps: RecordDeps & Partial<Pick<KeyDeps, 'keys'>>,
  input: RecordExpenseInput,
): RecordExpenseResult {
  const { db, logger } = deps;
  const { user } = input;

  const seen = findExpenseBySourceKey(db, input.sourceKey);
  if (seen !== undefined) {
    const ledger = findLedgerForMember(db, seen.ledgerId, user.id);
    if (ledger === undefined) throw new Error(`source key reused across users (${seen.id})`);
    logger.info({ expenseId: seen.id, userId: user.id }, 'duplicate expense delivery');
    return storedResult(deps, seen, ledger, true);
  }

  const ledger = targetLedger(deps, user, input.target ?? { kind: 'active' });

  // "Today" is the ledger's local date when the message was sent; a date word counts back from it.
  const sentOn = localDateOf(input.occurredAt, effectiveTimezone(deps, user, ledger));
  const parsed = resolveReading(
    parseExpenseText(input.text, ledger.defaultCurrency, sentOn),
    input.reading,
  );
  // A shared ledger splits every expense on its own (ADR-0030): a `/N` there records nothing.
  if ('split' in parsed && ledger.kind === 'shared') {
    return { kind: 'splitInGroup' };
  }
  if (parsed.kind === 'ambiguous') return { ...parsed, ledger };
  if (parsed.kind === 'futureDate') return { kind: 'futureDate' };
  if (parsed.kind !== 'expense') return parsed;
  // The member's sticky tag joins the text's own, and counts toward the cap (ADR-0029).
  const tags = withStickyTag(parsed.tags, stickyTagOf(deps, ledger.id, user.id));
  if (tags.length > MAX_TAGS_PER_EXPENSE) return { kind: 'tooManyTags' };
  // A split records the user's own share; the others' parts become debts once they are named.
  const split =
    parsed.split === undefined
      ? undefined
      : {
          whole: parsed.amountMinor,
          parts: parsed.split,
          ...splitShares(parsed.amountMinor, parsed.split),
        };

  const key = descriptionKey(parsed.description);
  const category = suggestCategory({
    description: parsed.description,
    categories: listActiveCategories(db, ledger.id),
    historyCategoryId: historyCategory(deps, ledger.id, key),
  });
  const stored = storeExpense(deps, {
    id: newExpenseId(deps),
    ledgerId: ledger.id,
    createdBy: user.id,
    amountMinor: split?.share ?? parsed.amountMinor,
    currency: parsed.currency,
    description: parsed.description,
    occurredAt: input.occurredAt,
    occurredOn: parsed.date ?? sentOn,
    sourceKey: input.sourceKey,
    createdAt: input.now,
    category: { id: category.id, name: category.name },
    descriptionKey: key,
    tags,
  });
  if (stored.kind === 'sealedDuplicate') return stored;
  const { expense, created } = stored;
  logger.info(
    { expenseId: expense.id, ledgerId: ledger.id, userId: user.id, duplicate: !created },
    'expense recorded',
  );
  return {
    kind: 'recorded',
    expense,
    ledger,
    duplicate: !created,
    fallbackCategory: inFallbackCategory(deps, expense),
    ...(split === undefined ? {} : { split }),
  };
}

// The ADR-0008 history step's category, skipped in a sealed ledger, whose rows store no
// description key (ADR-0020): the suggestion falls back to keyword rules.
export function historyCategory(
  { db }: Pick<RecordDeps, 'db'>,
  ledgerId: LedgerId,
  key: string,
): CategoryId | undefined {
  return isSealedLedger({ db }, ledgerId) ? undefined : findHistoryCategory(db, ledgerId, key);
}

export type StoreExpenseResult =
  | { readonly kind: 'stored'; readonly expense: Expense; readonly created: boolean }
  // The source key is taken by an expense of a sealed ledger that is locked.
  | { readonly kind: 'sealedDuplicate' };

// Inserts unless the source key exists, like insertExpenseOrGetExisting. In a sealed ledger
// (ADR-0020) the amount, description and category are sealed to its public key instead, and the
// plaintext columns stay NULL; the expense returned is what was sealed, so showing it needs no
// unlock. An existing row is returned opened, or `sealedDuplicate` while its ledger is locked.
export function storeExpense(
  deps: RecordDeps & Partial<Pick<KeyDeps, 'keys'>>,
  expense: Omit<NewExpense, 'categoryId'> & {
    readonly category: ExpenseCategory;
    readonly descriptionKey: string;
  },
): StoreExpenseResult {
  const { db } = deps;
  const { category, descriptionKey: key, ...fields } = expense;
  const publicKey = sealingKey(deps, expense.ledgerId);
  const inserted =
    publicKey === undefined
      ? insertExpenseOrGetExisting(db, { ...fields, categoryId: category.id, descriptionKey: key })
      : insertSealedExpenseOrGetExisting(db, {
          id: fields.id,
          ledgerId: fields.ledgerId,
          createdBy: fields.createdBy,
          currency: fields.currency,
          occurredAt: fields.occurredAt,
          occurredOn: fields.occurredOn,
          sourceKey: fields.sourceKey,
          createdAt: fields.createdAt,
          sealed: sealPayload(
            publicKey,
            { ledgerId: fields.ledgerId, expenseId: fields.id },
            {
              v: 1,
              amountMinor: fields.amountMinor,
              description: fields.description,
              categoryId: category.id,
              ...(fields.tags === undefined || fields.tags.length === 0
                ? {}
                : { tags: fields.tags }),
            },
          ),
        });
  if (inserted.created) {
    const shown: Expense = {
      id: fields.id,
      ledgerId: fields.ledgerId,
      createdBy: fields.createdBy,
      amountMinor: fields.amountMinor,
      currency: fields.currency,
      description: fields.description,
      occurredAt: fields.occurredAt,
      occurredOn: fields.occurredOn,
      sourceKey: fields.sourceKey,
      deletedAt: null,
      category,
      tags: fields.tags ?? [],
    };
    return { kind: 'stored', expense: shown, created: true };
  }
  const existing = openStored(deps, inserted.expense, inserted.expense.ledgerId);
  return existing === undefined
    ? { kind: 'sealedDuplicate' }
    : { kind: 'stored', expense: existing, created: false };
}

// A stored row as a recorded result: a sealed one opens while its ledger is unlocked.
function storedResult(
  deps: RecordDeps & Partial<Pick<KeyDeps, 'keys'>>,
  stored: StoredExpense,
  ledger: Ledger,
  duplicate: boolean,
): RecordExpenseResult {
  const expense = openStored(deps, stored, ledger.id);
  if (expense === undefined) return { kind: 'sealedDuplicate' };
  return {
    kind: 'recorded',
    expense,
    ledger,
    duplicate,
    fallbackCategory: inFallbackCategory(deps, expense),
  };
}

// A sealed row opens only while its ledger is unlocked; undefined otherwise.
function openStored(
  deps: RecordDeps & Partial<Pick<KeyDeps, 'keys'>>,
  stored: StoredExpense,
  ledgerId: LedgerId,
): Expense | undefined {
  if (!isSealed(stored)) return stored;
  if (deps.keys === undefined) return undefined;
  const opened = openExpenses({ db: deps.db, keys: deps.keys }, ledgerId, [stored]);
  return opened.kind === 'open' ? opened.expenses[0] : undefined;
}

// A stored expense without a category is not in the fallback either.
function inFallbackCategory({ db }: Pick<RecordDeps, 'db'>, expense: Expense): boolean {
  if (expense.category === null) return false;
  return findCategory(db, expense.ledgerId, expense.category.id)?.presetKey === FALLBACK_PRESET;
}

function targetLedger({ db }: Pick<RecordDeps, 'db'>, user: User, target: RecordTarget): Ledger {
  if (target.kind === 'active') {
    const ledger = findActiveLedger(db, user.id);
    if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
    return ledger;
  }
  const ledger = findLedgerForMember(db, target.ledgerId, user.id);
  if (ledger === undefined)
    throw new Error(`user ${user.id} is not a member of ${target.ledgerId}`);
  return ledger;
}

// Without a chosen reading the parse stands, so an ambiguous amount stays a question. With one,
// only an ambiguous parse that still offers that reading becomes an expense.
function resolveReading(
  parsed: ExpenseTextResult,
  reading: AmountReading['interpretation'] | undefined,
): ExpenseTextResult | { readonly kind: 'readingUnavailable' } {
  if (reading === undefined) return parsed;
  if (parsed.kind !== 'ambiguous') return { kind: 'readingUnavailable' };
  const chosen = parsed.readings.find((r) => r.interpretation === reading);
  if (chosen === undefined) return { kind: 'readingUnavailable' };
  return {
    kind: 'expense',
    amountMinor: chosen.amountMinor,
    currency: parsed.currency,
    description: parsed.description,
    ...(parsed.date === undefined ? {} : { date: parsed.date }),
    tags: parsed.tags,
  };
}

export type UndoExpenseResult =
  | { readonly kind: 'undone'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'alreadyUndone' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  // A sealed ledger that is locked: nothing is deleted (ADR-0020).
  | Locked;

// Soft-deletes an expense. Only its creator may undo it; a repeat leaves deleted_at unchanged.
export function undoExpense(
  deps: RecordDeps & Pick<KeyDeps, 'keys'>,
  input: { readonly user: User; readonly expenseId: ExpenseId; readonly now: Date },
): UndoExpenseResult {
  const { db, logger } = deps;
  const stored = findExpenseById(db, input.expenseId);
  if (stored === undefined) return { kind: 'notFound' };
  if (stored.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, stored.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  const expense = openExpense(deps, stored);
  if (isLocked(expense)) return expense;
  if (!softDeleteExpense(db, expense.id, input.now)) return { kind: 'alreadyUndone' };
  logger.info({ expenseId: expense.id, userId: input.user.id }, 'expense undone');
  return { kind: 'undone', expense, ledger };
}

export type RestoreExpenseResult =
  | { readonly kind: 'restored'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'alreadyRestored' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | Locked;

// Clears deleted_at. Only the creator may restore; compare-and-set on deleted_at IS NOT NULL,
// so a repeat changes nothing.
export function restoreExpense(
  deps: RecordDeps & Pick<KeyDeps, 'keys'>,
  input: { readonly user: User; readonly expenseId: ExpenseId },
): RestoreExpenseResult {
  const { db, logger } = deps;
  const stored = findExpenseById(db, input.expenseId);
  if (stored === undefined) return { kind: 'notFound' };
  if (stored.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, stored.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  const expense = openExpense(deps, stored);
  if (isLocked(expense)) return expense;
  if (!restoreDeletedExpense(db, expense.id)) return { kind: 'alreadyRestored' };
  logger.info({ expenseId: expense.id, userId: input.user.id }, 'expense restored');
  return { kind: 'restored', expense: { ...expense, deletedAt: null }, ledger };
}

// The user behind a Telegram account, without provisioning one: a group tap or command from
// someone who never recorded finds nobody and stores nothing.
export function findTelegramUser(
  { db }: Pick<ServiceDeps, 'db'>,
  telegramId: number,
): User | undefined {
  return findUserByIdentity(db, 'telegram', String(telegramId));
}

// The expense a source message recorded, deleted or not, sealed or not. Read-only.
export function findExpenseForSource(
  { db }: Pick<ServiceDeps, 'db'>,
  sourceKey: string,
): StoredExpense | undefined {
  return findExpenseBySourceKey(db, sourceKey);
}

function newExpenseId({ newId }: ServiceDeps): ExpenseId {
  return newId() as ExpenseId;
}
