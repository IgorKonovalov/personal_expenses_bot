import { findCategory, listActiveCategories } from '../db/categories.js';
import {
  findExpenseById,
  type Expense,
  type ExpenseCategory,
  type ExpenseId,
} from '../db/expenses.js';
import { findLedgerById, findLedgerForMember, type Ledger, type LedgerId } from '../db/ledgers.js';
import {
  advanceRule,
  findRule,
  findRuleAuthor,
  insertOccurrenceOrIgnore,
  insertRuleOrGetExisting,
  listRulesDueBy,
  listUserRules,
  type RecurringRule,
  type RuleId,
  type RuleTemplate,
} from '../db/recurring.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { dueInstant, monthlyOn, nextOccurrence, type Schedule } from '../domain/schedule.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { isLocked, isSealedLedger, openExpense, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, storeExpense, type RecordDeps } from './recordExpense.js';
import { resolveUserTimezone } from './settings.js';

// Recurring expenses (ADR-0031): a rule made from an expense records a copy of it on each date
// its schedule falls on, at 09:00 in the ledger's timezone. Each occurrence is claimed by its
// (rule, due date) key in the transaction that records the expense and advances the rule, so a
// repeated or overlapping tick records nothing twice. Logs carry ids and outcomes only.

export type RecurringDeps = RecordDeps & Pick<KeyDeps, 'keys'>;

// The schedules [Повторять] offers, by their callback letter.
export type ScheduleChoice = 'm';

const SCHEDULE_FOR: Record<ScheduleChoice, (date: LocalDate) => Schedule> = {
  m: monthlyOn,
};

export function scheduleFor(choice: ScheduleChoice, date: LocalDate): Schedule {
  return SCHEDULE_FOR[choice](date);
}

// At most this many missed occurrences of one rule are recorded per tick; the rest follow on the
// next tick.
export const MAX_CATCH_UP = 31;

export type RepeatRefusal =
  | { readonly kind: 'notFound' | 'forbidden' | 'deleted' }
  // The expense's ledger can't hold a rule: a shared or sealed one.
  | { readonly kind: 'unavailable' }
  | Locked;

export interface Repeatable {
  readonly kind: 'repeatable';
  readonly expense: Expense;
  readonly ledger: Ledger;
  // What each choice would make, from the expense's date.
  readonly schedules: readonly { readonly choice: ScheduleChoice; readonly schedule: Schedule }[];
}

const CHOICES: readonly ScheduleChoice[] = ['m'];

// [Повторять] on a card: only the expense's author, on a live expense.
export function repeatOptions(
  deps: RecurringDeps,
  input: { readonly user: User; readonly expenseId: ExpenseId },
): Repeatable | RepeatRefusal {
  const { db } = deps;
  const stored = findExpenseById(db, input.expenseId);
  if (stored === undefined) return { kind: 'notFound' };
  if (stored.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, stored.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (stored.deletedAt !== null) return { kind: 'deleted' };
  if (!canHoldRule(deps, ledger)) return { kind: 'unavailable' };
  const expense = openExpense(deps, stored);
  if (isLocked(expense)) return expense;
  return {
    kind: 'repeatable',
    expense,
    ledger,
    schedules: CHOICES.map((choice) => ({
      choice,
      schedule: scheduleFor(choice, expense.occurredOn),
    })),
  };
}

// Whether an expense of this ledger may be made recurring.
export function canHoldRule(deps: Pick<RecurringDeps, 'db'>, ledger: Ledger): boolean {
  return ledger.kind === 'personal' && !isSealedLedger(deps, ledger.id);
}

export type CreateRuleResult =
  | {
      readonly kind: 'created';
      readonly rule: RecurringRule;
      readonly expense: Expense;
      readonly ledger: Ledger;
      // False when a second tap found the rule the first one made.
      readonly created: boolean;
    }
  | RepeatRefusal;

// An `auto` rule from the expense's amount, currency, description and category, on the chosen
// schedule from the expense's date. Its first occurrence is the first such date after today in
// the ledger's timezone. A second tap of the same choice returns the live rule it made.
export function createRuleFromExpense(
  deps: RecurringDeps,
  input: {
    readonly user: User;
    readonly expenseId: ExpenseId;
    readonly choice: ScheduleChoice;
    readonly now: Date;
  },
): CreateRuleResult {
  const { db, logger } = deps;
  return db.transaction((): CreateRuleResult => {
    const found = repeatOptions(deps, input);
    if (found.kind !== 'repeatable') return found;
    const { expense, ledger } = found;
    const schedule = scheduleFor(input.choice, expense.occurredOn);
    const today = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
    const { rule, created } = insertRuleOrGetExisting(db, {
      id: deps.newId() as RuleId,
      ledgerId: ledger.id,
      userId: input.user.id,
      kind: 'expense',
      mode: 'auto',
      template: {
        amountMinor: expense.amountMinor,
        currency: expense.currency,
        description: expense.description,
        categoryId: expense.category?.id ?? null,
      },
      reminderText: null,
      schedule,
      nextDueOn: nextOccurrence(schedule, today),
      sourceKey: `exp:${expense.id}:${input.choice}`,
      createdAt: input.now,
    });
    if (created) {
      logger.info(
        { ruleId: rule.id, expenseId: expense.id, userId: input.user.id },
        'rule created',
      );
    }
    return { kind: 'created', rule, expense, ledger, created };
  })();
}

export interface RuleView {
  readonly rule: RecurringRule;
  // The rule's ledger; absent for a reminder.
  readonly ledger?: Ledger;
}

// /recurring: the user's rules, soonest first.
export function listRules(deps: Pick<RecurringDeps, 'db'>, user: User): RuleView[] {
  return listUserRules(deps.db, user.id).map((rule) => {
    const ledger = rule.ledgerId === null ? undefined : findLedgerById(deps.db, rule.ledgerId);
    return ledger === undefined ? { rule } : { rule, ledger };
  });
}

// A rule whose due instants have passed, with the dates due, oldest first.
export interface DueRule {
  readonly rule: RecurringRule;
  readonly dates: readonly LocalDate[];
}

// The rules with occurrences due by `now`: each date's 09:00 in the rule's current timezone has
// passed. At most MAX_CATCH_UP dates per rule.
export function dueRules(deps: RecurringDeps, now: Date): DueRule[] {
  // No zone is ahead of UTC+14, so no local date anywhere is later than this one.
  const latest = localDateOf(now, 'Etc/GMT-14');
  const due: DueRule[] = [];
  for (const rule of listRulesDueBy(deps.db, latest)) {
    const timeZone = ruleTimezone(deps, rule);
    if (timeZone === undefined) continue;
    const dates: LocalDate[] = [];
    let date = rule.nextDueOn;
    while (dates.length < MAX_CATCH_UP && dueInstant(date, timeZone) <= now) {
      dates.push(date);
      date = nextOccurrence(rule.schedule, date);
    }
    if (dates.length > 0) due.push({ rule, dates });
  }
  return due;
}

// The zone a rule's dates fire in: its ledger's effective zone (ADR-0015). Undefined when the
// author or the ledger is gone.
function ruleTimezone(deps: RecurringDeps, rule: RecurringRule): string | undefined {
  const author = findRuleAuthor(deps.db, rule.userId);
  if (author === undefined) return undefined;
  if (rule.ledgerId === null) return resolveUserTimezone(deps, author.user);
  const ledger = findLedgerById(deps.db, rule.ledgerId);
  return ledger === undefined ? undefined : effectiveTimezone(deps, author.user, ledger);
}

export type Fired = {
  readonly kind: 'recorded';
  readonly dueOn: LocalDate;
  readonly expense: Expense;
  readonly ledger: Ledger;
};

export interface FireResult {
  readonly rule: RecurringRule;
  readonly author: { readonly user: User; readonly telegramId: number };
  // What happened, oldest first. Empty when another tick claimed every date first.
  readonly fired: readonly Fired[];
}

// Runs a due rule's dates in order, each in its own transaction: the rule must still be live
// with its next due date on that date, which advances; the occurrence is claimed and the
// expense recorded. A date another tick claimed stops the run.
export function fireRule(deps: RecurringDeps, due: DueRule, now: Date): FireResult | undefined {
  const { db, logger } = deps;
  const author = findRuleAuthor(db, due.rule.userId);
  if (author === undefined) return undefined;
  const fired: Fired[] = [];
  for (const dueOn of due.dates) {
    const one = db.transaction((): Fired | undefined => {
      const rule = findRule(db, due.rule.id);
      if (rule?.nextDueOn !== dueOn || rule.kind !== 'expense' || rule.ledgerId === null) {
        return undefined;
      }
      if (!advanceRule(db, rule.id, dueOn, nextOccurrence(rule.schedule, dueOn))) return undefined;
      const ledger = findLedgerById(db, rule.ledgerId);
      if (ledger === undefined || rule.template === null) {
        throw new Error(`rule ${rule.id} has no ledger or template`);
      }
      const expense = recordOccurrence(deps, {
        rule,
        template: rule.template,
        ledger,
        author: author.user,
        dueOn,
        now,
      });
      if (
        !insertOccurrenceOrIgnore(db, {
          ruleId: rule.id,
          dueOn,
          outcome: 'recorded',
          expenseId: expense.id,
        })
      ) {
        throw new Error(`occurrence ${rule.id} ${dueOn} claimed twice`);
      }
      return { kind: 'recorded', dueOn, expense, ledger };
    })();
    if (one === undefined) break;
    logger.info(
      { ruleId: due.rule.id, expenseId: one.expense.id, outcome: one.kind },
      'recurring occurrence',
    );
    fired.push(one);
  }
  return { rule: due.rule, author, fired };
}

// The template recorded as the author's expense on its due date, under the source key
// `rec:<rule>:<due date>`, at 09:00 local.
function recordOccurrence(
  deps: RecurringDeps,
  input: {
    readonly rule: RecurringRule;
    readonly template: RuleTemplate;
    readonly ledger: Ledger;
    readonly author: User;
    readonly dueOn: LocalDate;
    readonly now: Date;
  },
): Expense {
  const { rule, template, ledger, dueOn } = input;
  const stored = storeExpense(deps, {
    id: deps.newId() as ExpenseId,
    ledgerId: ledger.id,
    createdBy: rule.userId,
    amountMinor: template.amountMinor,
    currency: template.currency,
    description: template.description,
    occurredAt: dueInstant(dueOn, effectiveTimezone(deps, input.author, ledger)),
    occurredOn: dueOn,
    sourceKey: `rec:${rule.id}:${dueOn}`,
    createdAt: input.now,
    category: categoryFor(deps, ledger.id, template),
    descriptionKey: descriptionKey(template.description),
  });
  if (stored.kind !== 'stored') throw new Error(`occurrence ${rule.id} ${dueOn} is sealed`);
  return stored.expense;
}

// The template's category while the ledger still has it, else the one the description suggests.
function categoryFor(
  { db }: Pick<RecurringDeps, 'db'>,
  ledgerId: LedgerId,
  template: RuleTemplate,
): ExpenseCategory {
  const kept =
    template.categoryId === null ? undefined : findCategory(db, ledgerId, template.categoryId);
  if (kept !== undefined) return { id: kept.id, name: kept.name };
  const suggested = suggestCategory({
    description: template.description,
    categories: listActiveCategories(db, ledgerId),
  });
  return { id: suggested.id, name: suggested.name };
}
