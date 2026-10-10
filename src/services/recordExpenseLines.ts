import { listActiveCategories } from '../db/categories.js';
import { findExpenseBySourceKey, type Expense, type StoredExpense } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import {
  MAX_EXPENSE_LINES,
  expenseLineTexts,
  readExpenseLines,
  type BadLineReason,
} from '../domain/expenseLines.js';
import { MAX_TAGS_PER_EXPENSE } from '../domain/tags.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import {
  effectiveTimezone,
  historyCategory,
  storeExpense,
  type RecordDeps,
} from './recordExpense.js';
import { stickyTagOf, withStickyTag } from './stickyTag.js';

// A multi-line message (ADR-0049): every line an expense, recorded in one transaction or not at
// all. Line 1 takes the message's source key and line n `<key>:<n>`, so a redelivery finds line
// 1's key and re-shows the stored batch.

// The expenses one message recorded, in line order, deleted ones included.
export interface Batch {
  readonly ledger: Ledger;
  // Line 1's key; line n's is `${sourceKey}:${n}`.
  readonly sourceKey: string;
  // The sender's local date of the message: a line dated otherwise names its date.
  readonly sentOn: LocalDate;
  readonly expenses: readonly Expense[];
}

export type RecordLinesResult =
  // Not a multi-line message: the single-expense path reads the text.
  | { readonly kind: 'single' }
  | {
      readonly kind: 'badLine';
      readonly n: number;
      readonly line: string;
      readonly reason: BadLineReason;
    }
  | { readonly kind: 'tooMany' }
  // A redelivery of a batch in a sealed ledger that is locked (ADR-0020).
  | { readonly kind: 'sealedDuplicate' }
  | (Batch & { readonly kind: 'recorded'; readonly duplicate: boolean });

type Deps = RecordDeps & Pick<KeyDeps, 'keys'>;

// Line n's source key, 1-based.
export function lineKey(sourceKey: string, n: number): string {
  return n === 1 ? sourceKey : `${sourceKey}:${n}`;
}

// Records each line of a multi-line text into the active ledger, in the category the one-line
// path would pick, dated by its own date word or the message's day. A line-1 key seen before
// with a line 2 behind it returns the stored batch and records nothing.
export function recordExpenseLines(
  deps: Deps,
  input: {
    readonly user: User;
    readonly text: string;
    // The adapter's key for the message, `tg:<chat_id>:<message_id>`.
    readonly sourceKey: string;
    // When the user sent it.
    readonly occurredAt: Date;
    readonly now: Date;
  },
): RecordLinesResult {
  const { db, logger } = deps;
  const { user, sourceKey } = input;

  if (findExpenseBySourceKey(db, sourceKey) !== undefined) {
    // A key without a line 2 is a one-line expense: the single path answers its redelivery.
    if (findExpenseBySourceKey(db, lineKey(sourceKey, 2)) === undefined) return { kind: 'single' };
    const stored = storedBatch(deps, { user, sourceKey });
    if (stored === undefined) throw new Error('a batch key is stored in another user’s ledger');
    if ('kind' in stored) return { kind: 'sealedDuplicate' };
    logger.info({ userId: user.id, ledgerId: stored.ledger.id }, 'duplicate batch delivery');
    return { kind: 'recorded', duplicate: true, ...stored };
  }

  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  const sentOn = localDateOf(input.occurredAt, effectiveTimezone(deps, user, ledger));
  const read = readExpenseLines(input.text, ledger.defaultCurrency, sentOn);
  if (read.kind !== 'lines') return read;

  // The member's sticky tag joins each line's own and counts toward the cap (ADR-0029).
  const sticky = stickyTagOf(deps, ledger.id, user.id);
  const lines = read.lines.map((line) => ({ ...line, tags: withStickyTag(line.tags, sticky) }));
  const overTagged = lines.findIndex((line) => line.tags.length > MAX_TAGS_PER_EXPENSE);
  if (overTagged !== -1) {
    return {
      kind: 'badLine',
      n: overTagged + 1,
      line: expenseLineTexts(input.text)[overTagged] ?? '',
      reason: 'tooManyTags',
    };
  }

  const categories = listActiveCategories(db, ledger.id);
  const expenses = db.transaction((): Expense[] =>
    lines.map((line, index) => {
      const key = descriptionKey(line.description);
      const category = suggestCategory({
        description: line.description,
        categories,
        historyCategoryId: historyCategory(deps, ledger.id, key),
      });
      const stored = storeExpense(deps, {
        id: deps.newId() as Expense['id'],
        ledgerId: ledger.id,
        createdBy: user.id,
        amountMinor: line.amountMinor,
        currency: line.currency,
        description: line.description,
        occurredAt: input.occurredAt,
        occurredOn: line.date ?? sentOn,
        sourceKey: lineKey(sourceKey, index + 1),
        createdAt: input.now,
        category: { id: category.id, name: category.name },
        descriptionKey: key,
        tags: line.tags,
      });
      // Line 1's key was free a moment ago, in this same process: no line can be taken.
      if (stored.kind !== 'stored') throw new Error('a batch line key is taken');
      return stored.expense;
    }),
  )();
  logger.info(
    { userId: user.id, ledgerId: ledger.id, count: expenses.length },
    'expense batch recorded',
  );
  return { kind: 'recorded', duplicate: false, ledger, sourceKey, sentOn, expenses };
}

// The batch stored under `sourceKey`, re-read for its card: every line's expense in its current
// state, deleted ones included. Undefined when line 1 is gone or in a ledger the user isn't a
// member of; a sealed ledger that is locked reads as `locked`.
export function storedBatch(
  deps: Deps,
  input: { readonly user: User; readonly sourceKey: string; readonly ledgerId?: LedgerId },
): Batch | Locked | undefined {
  const { db } = deps;
  const rows: StoredExpense[] = [];
  for (let n = 1; n <= MAX_EXPENSE_LINES; n++) {
    const row = findExpenseBySourceKey(db, lineKey(input.sourceKey, n));
    if (row === undefined) break;
    rows.push(row);
  }
  const [first] = rows;
  if (first === undefined) return undefined;
  if (input.ledgerId !== undefined && first.ledgerId !== input.ledgerId) return undefined;
  const ledger = findLedgerForMember(db, first.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  const opened = openExpenses(deps, ledger.id, rows);
  if (opened.kind === 'locked') return opened;
  return {
    ledger,
    sourceKey: input.sourceKey,
    sentOn: localDateOf(first.occurredAt, effectiveTimezone(deps, input.user, ledger)),
    expenses: opened.expenses,
  };
}
