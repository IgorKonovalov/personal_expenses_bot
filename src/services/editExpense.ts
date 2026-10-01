import {
  findExpenseById,
  setExpenseAmount,
  setExpenseDate,
  setExpenseDescription,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { descriptionKey } from '../domain/categories.js';
import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import { parseDateSuffix } from '../domain/dateText.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { parseAmount, type AmountReading } from '../domain/money.js';
import { localDateOf, parseLocalDate, type LocalDate } from '../domain/time.js';
import {
  cancelFlow,
  cancelFlowIf,
  completeFlow,
  isEditOf,
  startFlow,
  type EditFlow,
} from './flowSessions.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// Editing an expense's amount, description or date from its card (ADR-0011), each through an
// ADR-0009 text flow; the date also through quick buttons. Only the creator edits, and only a
// live expense. Every write is compare-and-set, so the same value writes nothing.

interface ExpenseInput {
  readonly user: User;
  readonly expenseId: ExpenseId;
}

export type EditRefusal =
  { readonly kind: 'notFound' } | { readonly kind: 'forbidden' } | { readonly kind: 'deleted' };

interface Editable {
  readonly kind: 'editable';
  readonly expense: Expense;
  readonly ledger: Ledger;
}

export type OpenEditResult = Editable | EditRefusal;

// The expense behind [Изменить] and a field pick, for its creator while it is live.
export function openEdit({ db }: Pick<RecordDeps, 'db'>, input: ExpenseInput): OpenEditResult {
  const expense = findExpenseById(db, input.expenseId);
  if (expense === undefined) return { kind: 'notFound' };
  if (expense.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, expense.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (expense.deletedAt !== null) return { kind: 'deleted' };
  return { kind: 'editable', expense, ledger };
}

export type StartEditResult = (Editable & { readonly today: LocalDate }) | EditRefusal;

// Starts the field's flow, replacing any pending one. `today` is the local date in the ledger's
// zone (ADR-0015), for the date prompt's quick buttons.
export function startEdit(
  deps: RecordDeps,
  input: ExpenseInput & { readonly kind: EditFlow['kind']; readonly now: Date },
): StartEditResult {
  const found = openEdit(deps, input);
  if (found.kind !== 'editable') return found;
  startFlow(deps, input.user, { kind: input.kind, expenseId: input.expenseId }, input.now);
  const timezone = effectiveTimezone(deps, input.user, found.ledger);
  return { ...found, today: localDateOf(input.now, timezone) };
}

export type EditAnswerRefusal =
  | { readonly reason: 'invalidAmount' | 'expenseShaped' | 'empty' | 'invalidDate' | 'futureDate' }
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
  deps: RecordDeps,
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
      const expense = findExpenseById(db, flow.expenseId);
      const ledger =
        expense === undefined ? undefined : findLedgerForMember(db, expense.ledgerId, user.id);
      return ledger === undefined ? { kind: 'gone', expense } : { kind: 'gone', expense, ledger };
    }
    const { expense, ledger } = found;
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
        changed = setExpenseAmount(db, expense.id, money, now);
        edited = { ...expense, ...money };
        break;
      }
      case 'editDescription': {
        if (text === '') return refuse({ reason: 'empty' });
        changed = setExpenseDescription(
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
  deps: RecordDeps,
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
    return { ...found, expense: { ...found.expense, occurredOn: date }, changed };
  })();
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
