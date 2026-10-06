import {
  findExpenseById,
  isSealed,
  resealExpense,
  setExpenseAmount,
  setExpenseDate,
  setExpenseDescription,
  setExpenseTags,
  type Expense,
  type ExpenseId,
  type StoredExpense,
} from '../db/expenses.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { descriptionKey } from '../domain/categories.js';
import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import { parseDateSuffix } from '../domain/dateText.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { parseAmount, type AmountReading } from '../domain/money.js';
import { MAX_TAGS_PER_EXPENSE, tagOfWord, uniqueTags, type TagName } from '../domain/tags.js';
import { localDateOf, parseLocalDate, type LocalDate } from '../domain/time.js';
import {
  cancelFlow,
  cancelFlowIf,
  completeFlow,
  isEditOf,
  startFlow,
  type EditFlow,
} from './flowSessions.js';
import { isLocked, openExpense, resealed, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// Editing an expense's amount, description, date or tags from its card (ADR-0011), each through an
// ADR-0009 text flow; the date also through quick buttons. Only the creator edits, and only a
// live expense. Every write is compare-and-set, so the same value writes nothing. An expense of
// a sealed ledger (ADR-0020) is edited only while unlocked; an amount or description edit seals
// its whole payload again.

type Deps = RecordDeps & Pick<KeyDeps, 'keys'>;

interface ExpenseInput {
  readonly user: User;
  readonly expenseId: ExpenseId;
}

export type EditRefusal =
  | { readonly kind: 'notFound' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'deleted' }
  | Locked;

interface Editable {
  readonly kind: 'editable';
  readonly expense: Expense;
  readonly ledger: Ledger;
}

interface Found extends Editable {
  readonly stored: StoredExpense;
}

export type OpenEditResult = Found | EditRefusal;

// The expense behind [Изменить] and a field pick, for its creator while it is live.
export function openEdit(
  deps: Pick<RecordDeps, 'db'> & Pick<KeyDeps, 'keys'>,
  input: ExpenseInput,
): OpenEditResult {
  const { db } = deps;
  const stored = findExpenseById(db, input.expenseId);
  if (stored === undefined) return { kind: 'notFound' };
  if (stored.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, stored.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (stored.deletedAt !== null) return { kind: 'deleted' };
  const expense = openExpense(deps, stored);
  if (isLocked(expense)) return expense;
  return { kind: 'editable', expense, stored, ledger };
}

export type StartEditResult = (Editable & { readonly today: LocalDate }) | EditRefusal;

// Starts the field's flow, replacing any pending one. `today` is the local date in the ledger's
// zone (ADR-0015), for the date prompt's quick buttons.
export function startEdit(
  deps: Deps,
  input: ExpenseInput & { readonly kind: EditFlow['kind']; readonly now: Date },
): StartEditResult {
  const found = openEdit(deps, input);
  if (found.kind !== 'editable') return found;
  startFlow(deps, input.user, { kind: input.kind, expenseId: input.expenseId }, input.now);
  const timezone = effectiveTimezone(deps, input.user, found.ledger);
  return { ...found, today: localDateOf(input.now, timezone) };
}

export type EditAnswerRefusal =
  | {
      readonly reason:
        | 'invalidAmount'
        | 'expenseShaped'
        | 'empty'
        | 'invalidDate'
        | 'futureDate'
        | 'noTags'
        | 'tooManyTags';
    }
  | {
      readonly reason: 'ambiguousAmount';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
    };

export type EditAnswerResult =
  | (Editable & { readonly changed: boolean })
  // The flow stays pending and the prompt is asked again.
  | ({
      readonly kind: 'invalid';
      readonly expense: Expense;
      readonly today: LocalDate;
    } & EditAnswerRefusal)
  // The expense was deleted or became unavailable mid-flow: the flow is cleared, nothing written.
  | { readonly kind: 'gone'; readonly expense: Expense | undefined; readonly ledger?: Ledger };

// A typed answer to an edit prompt. The write and the flow's completion commit together, keyed
// by `inputKey`, so a redelivered answer finds the flow already answered.
export function answerEditFlow(
  deps: Deps,
  input: {
    readonly user: User;
    readonly flow: EditFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): EditAnswerResult {
  const { db, logger } = deps;
  const { user, flow, now } = input;
  return db.transaction((): EditAnswerResult => {
    const found = openEdit(deps, { user, expenseId: flow.expenseId });
    if (found.kind !== 'editable') {
      cancelFlow(deps, user);
      const stored = findExpenseById(db, flow.expenseId);
      const opened = stored === undefined ? undefined : openExpense(deps, stored);
      const expense = opened === undefined || isLocked(opened) ? undefined : opened;
      const ledger =
        expense === undefined ? undefined : findLedgerForMember(db, expense.ledgerId, user.id);
      return ledger === undefined ? { kind: 'gone', expense } : { kind: 'gone', expense, ledger };
    }
    const { expense, stored, ledger } = found;
    const today = localDateOf(now, effectiveTimezone(deps, user, ledger));
    const refuse = (refusal: EditAnswerRefusal): EditAnswerResult => ({
      kind: 'invalid',
      expense,
      today,
      ...refusal,
    });
    const text = input.text.trim();
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    const asExpense = parseExpenseText(text, ledger.defaultCurrency).kind;
    if (asExpense === 'expense' || asExpense === 'ambiguous') {
      return refuse({ reason: 'expenseShaped' });
    }

    let edited: Expense;
    let changed: boolean;
    switch (flow.kind) {
      case 'editAmount': {
        const parsed = parseAmountAnswer(text, expense.currency);
        if (parsed.kind === 'ambiguous') {
          return refuse({
            reason: 'ambiguousAmount',
            readings: parsed.readings,
            currency: parsed.currency,
          });
        }
        if (parsed.kind === 'invalid') return refuse({ reason: 'invalidAmount' });
        const money = { amountMinor: parsed.amountMinor, currency: parsed.currency };
        changed = isSealed(stored)
          ? (money.amountMinor !== expense.amountMinor || money.currency !== expense.currency) &&
            resealExpense(db, stored.id, {
              sealed: resealed(deps, stored, { amountMinor: money.amountMinor }),
              currency: money.currency,
              updatedAt: now,
            })
          : setExpenseAmount(db, expense.id, money, now);
        edited = { ...expense, ...money };
        break;
      }
      case 'editDescription': {
        if (text === '') return refuse({ reason: 'empty' });
        // A sealed row stores no description key: the history step skips sealed ledgers.
        changed = isSealed(stored)
          ? text !== expense.description &&
            resealExpense(db, stored.id, {
              sealed: resealed(deps, stored, { description: text }),
              currency: stored.currency,
              updatedAt: now,
            })
          : setExpenseDescription(
              db,
              expense.id,
              { description: text, descriptionKey: descriptionKey(text) },
              now,
            );
        edited = { ...expense, description: text };
        break;
      }
      case 'editDate': {
        const suffix = parseDateSuffix(text, today);
        if (suffix.kind === 'none') return refuse({ reason: 'invalidDate' });
        if (suffix.kind === 'future') return refuse({ reason: 'futureDate' });
        changed = setExpenseDate(db, expense.id, suffix.date, now);
        edited = { ...expense, occurredOn: suffix.date };
        break;
      }
      case 'editTags': {
        const tags = parseTagsAnswer(text);
        if (tags === undefined) return refuse({ reason: 'noTags' });
        if (tags.length > MAX_TAGS_PER_EXPENSE) return refuse({ reason: 'tooManyTags' });
        changed = isSealed(stored)
          ? tags.join(' ') !== expense.tags.join(' ') &&
            resealExpense(db, stored.id, {
              sealed: resealed(deps, stored, { tags }),
              currency: stored.currency,
              updatedAt: now,
            })
          : setExpenseTags(db, expense.id, tags, now);
        edited = { ...expense, tags };
        break;
      }
    }
    completeFlow(deps, user, input.inputKey);
    if (changed) {
      logger.info({ expenseId: expense.id, userId: user.id, field: flow.kind }, 'expense edited');
    }
    return { kind: 'editable', expense: edited, ledger, changed };
  })();
}

export type SetDateResult =
  | (Editable & { readonly changed: boolean })
  // Not a calendar date, or after the user's today.
  | { readonly kind: 'unavailable' }
  | EditRefusal;

// A date quick button. It carries an absolute date, so a tap after midnight still sets the day
// the button showed. Clears the pending flow only when it is this expense's date edit.
export function setDateFromButton(
  deps: Deps,
  input: ExpenseInput & { readonly date: string; readonly now: Date },
): SetDateResult {
  const { db, logger } = deps;
  const { user, now } = input;
  return db.transaction((): SetDateResult => {
    const found = openEdit(deps, input);
    if (found.kind !== 'editable') return found;
    const date = parseLocalDate(input.date);
    const today = localDateOf(now, effectiveTimezone(deps, user, found.ledger));
    if (date === undefined || date > today) return { kind: 'unavailable' };
    cancelFlowIf(deps, user, isEditOf(found.expense.id, 'editDate'));
    const changed = setExpenseDate(db, found.expense.id, date, now);
    if (changed) {
      logger.info(
        { expenseId: found.expense.id, userId: user.id, field: 'editDate' },
        'expense edited',
      );
    }
    const { ledger } = found;
    return { kind: 'editable', expense: { ...found.expense, occurredOn: date }, ledger, changed };
  })();
}

// The answer to the tags prompt, which replaces the expense's tags: `-` for none, else its
// `#tag` words. Undefined for a text with no tag word.
function parseTagsAnswer(text: string): TagName[] | undefined {
  if (text === '-') return [];
  const tags = uniqueTags(text.split(/\s+/).flatMap((word) => tagOfWord(word) ?? []));
  return tags.length === 0 ? undefined : tags;
}

type AmountAnswer =
  | { readonly kind: 'ok'; readonly amountMinor: number; readonly currency: CurrencyCode }
  | {
      readonly kind: 'ambiguous';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
    }
  | { readonly kind: 'invalid' };

// `<amount> [CUR]`, read by the ADR-0004 parser. Without a code the expense keeps its currency.
function parseAmountAnswer(text: string, current: CurrencyCode): AmountAnswer {
  const coded = /^(.*\S)\s+([A-Za-z]{3})$/.exec(text);
  const named = coded?.[2] === undefined ? undefined : toCurrencyCode(coded[2]);
  const currency = named ?? current;
  const token = named === undefined ? text : (coded?.[1] ?? '');
  const amount = parseAmount(token, currency);
  switch (amount.kind) {
    case 'ok':
      return { kind: 'ok', amountMinor: amount.amountMinor, currency };
    case 'ambiguous':
      return { kind: 'ambiguous', readings: amount.readings, currency };
    case 'invalid':
      return { kind: 'invalid' };
  }
}
