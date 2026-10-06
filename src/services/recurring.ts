import { findCategory, listActiveCategories } from '../db/categories.js';
import {
  findExpenseById,
  type Expense,
  type ExpenseCategory,
  type ExpenseId,
} from '../db/expenses.js';
import { findActiveChatOfLedger } from '../db/ledgerChats.js';
import { findLedgerById, findLedgerForMember, type Ledger, type LedgerId } from '../db/ledgers.js';
import {
  advanceRule,
  answerAskedOccurrence,
  findOccurrenceOutcome,
  findRule,
  findRuleAuthor,
  insertOccurrenceOrIgnore,
  insertRuleOrGetExisting,
  listRulesDueBy,
  listUserRules,
  pauseRule,
  setRuleMode,
  softDeleteRule,
  type OccurrenceOutcome,
  type RecurringRule,
  type RuleId,
  type RuleMode,
  type RuleTemplate,
} from '../db/recurring.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import {
  dueInstant,
  monthlyOn,
  nextOccurrence,
  weeklyOn,
  yearlyOn,
  type Schedule,
} from '../domain/schedule.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { isLocked, isSealedLedger, openExpense, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, storeExpense, type RecordDeps } from './recordExpense.js';
import { resolveUserTimezone } from './settings.js';
import { cancelFlow, completeFlow, startFlow, type RecurringAmountFlow } from './flowSessions.js';
import { parseAmount } from '../domain/money.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';

// Recurring expenses (ADR-0031): a rule made from an expense records a copy of it on each date
// its schedule falls on, at 09:00 in the ledger's timezone. Each occurrence is claimed by its
// (rule, due date) key in the transaction that records the expense and advances the rule, so a
// repeated or overlapping tick records nothing twice. Logs carry ids and outcomes only.

export type RecurringDeps = RecordDeps & Pick<KeyDeps, 'keys'>;

// The schedules [Повторять] offers, by their callback letter.
export type ScheduleChoice = 'm' | 'w' | 'y';

const SCHEDULE_FOR: Record<ScheduleChoice, (date: LocalDate) => Schedule> = {
  m: monthlyOn,
  w: weeklyOn,
  y: yearlyOn,
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

const CHOICES: readonly ScheduleChoice[] = ['m', 'w', 'y'];

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
  return !isSealedLedger(deps, ledger.id);
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
    // A reminder sends only its latest missed date (ADR-0031), so it scans past the cap.
    const cap = rule.kind === 'reminder' ? MAX_REMINDER_SCAN : MAX_CATCH_UP;
    const dates: LocalDate[] = [];
    let date = rule.nextDueOn;
    while (dates.length < cap && dueInstant(date, timeZone) <= now) {
      dates.push(date);
      date = nextOccurrence(rule.schedule, date);
    }
    if (dates.length > 0)
      due.push({ rule, dates: rule.kind === 'reminder' ? dates.slice(-1) : dates });
  }
  return due;
}

// Enough for years of a weekly reminder missed.
const MAX_REMINDER_SCAN = 1000;

// The zone a rule's dates fire in: its ledger's effective zone (ADR-0015). Undefined when the
// author or the ledger is gone.
function ruleTimezone(deps: RecurringDeps, rule: RecurringRule): string | undefined {
  const author = findRuleAuthor(deps.db, rule.userId);
  if (author === undefined) return undefined;
  if (rule.ledgerId === null) return resolveUserTimezone(deps, author.user);
  const ledger = findLedgerById(deps.db, rule.ledgerId);
  return ledger === undefined ? undefined : effectiveTimezone(deps, author.user, ledger);
}

export type Fired =
  | {
      readonly kind: 'recorded';
      readonly dueOn: LocalDate;
      readonly expense: Expense;
      readonly ledger: Ledger;
    }
  // An `ask` occurrence waiting for the author's answer.
  | { readonly kind: 'asked'; readonly dueOn: LocalDate; readonly ledger: Ledger }
  // A missed `ask` occurrence past the last ASK_CATCH_UP: nothing recorded, nothing asked.
  | { readonly kind: 'skipped'; readonly dueOn: LocalDate }
  // A reminder's date: its text is sent, nothing is recorded.
  | { readonly kind: 'reminded'; readonly dueOn: LocalDate; readonly text: string };

// After downtime an `ask` rule asks about this many of its latest missed dates; the earlier
// ones are skipped and counted.
export const ASK_CATCH_UP = 3;

export interface FireResult {
  readonly rule: RecurringRule;
  readonly author: { readonly user: User; readonly telegramId: number };
  // What happened, oldest first. Empty when another tick claimed every date first.
  readonly fired: readonly Fired[];
  // The group chat a shared ledger is bound to: where the notices go. Absent: the author's DM.
  readonly groupChatId?: number;
}

// Runs a due rule's dates in order, each in its own transaction: the rule must still be live
// with its next due date on that date, which advances, and the occurrence is claimed. An `auto`
// rule records the expense; an `ask` rule records nothing until answered. A date another tick
// claimed stops the run.
export function fireRule(deps: RecurringDeps, due: DueRule, now: Date): FireResult | undefined {
  const { db, logger } = deps;
  const author = findRuleAuthor(db, due.rule.userId);
  if (author === undefined) return undefined;
  if (due.rule.kind === 'reminder') {
    const reminded = fireReminder(deps, due);
    return { rule: due.rule, author, fired: reminded === undefined ? [] : [reminded] };
  }
  // A shared ledger's rule (ADR-0014) fires only while its author is a member, and its notices
  // go to the ledger's bound chat, else to the author's private chat.
  const { ledgerId } = due.rule;
  if (ledgerId !== null && findLedgerForMember(db, ledgerId, due.rule.userId) === undefined) {
    if (pauseRule(db, due.rule.id, now)) logger.info({ ruleId: due.rule.id }, 'rule paused');
    return { rule: due.rule, author, fired: [] };
  }
  const chat = ledgerId === null ? undefined : findActiveChatOfLedger(db, ledgerId);
  const groupChatId = chat === undefined ? {} : { groupChatId: Number(chat) };
  const asked = due.dates.length - ASK_CATCH_UP;
  const fired: Fired[] = [];
  for (const [index, dueOn] of due.dates.entries()) {
    const one = db.transaction((): Fired | undefined => {
      const rule = findRule(db, due.rule.id);
      if (rule?.nextDueOn !== dueOn || rule.kind !== 'expense' || rule.ledgerId === null) {
        return undefined;
      }
      if (!advanceRule(db, rule.id, dueOn, nextOccurrence(rule.schedule, dueOn))) return undefined;
      const ledger = findLedgerById(db, rule.ledgerId);
      if (ledger === undefined) throw new Error(`rule ${rule.id} has no ledger`);
      const claim = (outcome: OccurrenceOutcome, expenseId: ExpenseId | null) => {
        if (!insertOccurrenceOrIgnore(db, { ruleId: rule.id, dueOn, outcome, expenseId })) {
          throw new Error(`occurrence ${rule.id} ${dueOn} claimed twice`);
        }
      };
      if (rule.mode === 'ask') {
        const outcome = index < asked ? 'skipped' : 'asked';
        claim(outcome, null);
        return outcome === 'asked' ? { kind: 'asked', dueOn, ledger } : { kind: 'skipped', dueOn };
      }
      if (rule.template === null) throw new Error(`rule ${rule.id} has no template`);
      const expense = recordOccurrence(deps, {
        rule,
        template: rule.template,
        ledger,
        author: author.user,
        dueOn,
        now,
      });
      claim('recorded', expense.id);
      return { kind: 'recorded', dueOn, expense, ledger };
    })();
    if (one === undefined) break;
    logger.info(
      {
        ruleId: due.rule.id,
        ...(one.kind === 'recorded' ? { expenseId: one.expense.id } : {}),
        outcome: one.kind,
      },
      'recurring occurrence',
    );
    fired.push(one);
  }
  return { rule: due.rule, author, fired, ...groupChatId };
}

// A reminder's latest due date: the rule moves from the next due date it was read with to the
// one after that date, skipping any earlier missed ones, and the date is claimed as reminded.
function fireReminder(deps: RecurringDeps, due: DueRule): Fired | undefined {
  const { db, logger } = deps;
  const [dueOn] = due.dates;
  if (dueOn === undefined) return undefined;
  const fired = db.transaction((): Fired | undefined => {
    const rule = findRule(db, due.rule.id);
    if (rule?.reminderText == null) return undefined;
    const from = due.rule.nextDueOn;
    if (!advanceRule(db, rule.id, from, nextOccurrence(rule.schedule, dueOn))) return undefined;
    if (
      !insertOccurrenceOrIgnore(db, {
        ruleId: rule.id,
        dueOn,
        outcome: 'reminded',
        expenseId: null,
      })
    ) {
      throw new Error(`occurrence ${rule.id} ${dueOn} claimed twice`);
    }
    return { kind: 'reminded', dueOn, text: rule.reminderText };
  })();
  if (fired !== undefined) {
    logger.info({ ruleId: due.rule.id, outcome: fired.kind }, 'recurring occurrence');
  }
  return fired;
}

// The longest reminder text, in characters.
export const MAX_REMINDER_LENGTH = 200;

export type ReminderTextResult =
  | { readonly kind: 'valid'; readonly text: string }
  | { readonly kind: 'invalid'; readonly reason: 'empty' | 'tooLong' | 'expenseShaped' };

// A typed reminder text: 1-200 characters, and not an expense (ADR-0009). Completes the flow
// when valid.
export function answerReminderText(
  deps: RecurringDeps,
  input: {
    readonly user: User;
    readonly text: string;
    readonly inputKey: string;
    readonly currency: CurrencyCode;
  },
): ReminderTextResult {
  const text = input.text.trim();
  if (text === '') return { kind: 'invalid', reason: 'empty' };
  if (Array.from(text).length > MAX_REMINDER_LENGTH) return { kind: 'invalid', reason: 'tooLong' };
  const asExpense = parseExpenseText(text, input.currency).kind;
  if (asExpense === 'expense' || asExpense === 'ambiguous') {
    return { kind: 'invalid', reason: 'expenseShaped' };
  }
  completeFlow(deps, input.user, input.inputKey);
  return { kind: 'valid', text };
}

// The date a reminder's schedule is chosen from: the user's today.
export function reminderToday(deps: RecurringDeps, user: User, now: Date): LocalDate {
  return localDateOf(now, resolveUserTimezone(deps, user));
}

// A personal reminder on the chosen schedule from today, first due the next such date.
export function createReminder(
  deps: RecurringDeps,
  input: {
    readonly user: User;
    readonly text: string;
    readonly choice: ScheduleChoice;
    readonly now: Date;
  },
): RecurringRule {
  const today = reminderToday(deps, input.user, input.now);
  const schedule = scheduleFor(input.choice, today);
  const { rule } = insertRuleOrGetExisting(deps.db, {
    id: deps.newId() as RuleId,
    ledgerId: null,
    userId: input.user.id,
    kind: 'reminder',
    mode: 'auto',
    template: null,
    reminderText: input.text,
    schedule,
    nextDueOn: nextOccurrence(schedule, today),
    sourceKey: null,
    createdAt: input.now,
  });
  deps.logger.info({ ruleId: rule.id, userId: input.user.id }, 'reminder created');
  return rule;
}

export type AskRefusal =
  | { readonly kind: 'notFound' | 'forbidden' }
  // Recorded or skipped already: a double tap, or an answer from another prompt.
  | { readonly kind: 'answered'; readonly outcome: OccurrenceOutcome };

export interface AskTarget {
  readonly kind: 'asked';
  readonly rule: RecurringRule;
  readonly template: RuleTemplate;
  readonly ledger: Ledger;
}

// An `ask` occurrence still waiting, for the rule's author only.
export function askTarget(
  { db }: Pick<RecurringDeps, 'db'>,
  input: { readonly user: User; readonly ruleId: RuleId; readonly dueOn: LocalDate },
): AskTarget | AskRefusal {
  const rule = findRule(db, input.ruleId);
  const outcome = findOccurrenceOutcome(db, input.ruleId, input.dueOn);
  if (rule === undefined || outcome === undefined || rule.ledgerId === null) {
    return { kind: 'notFound' };
  }
  if (rule.userId !== input.user.id) return { kind: 'forbidden' };
  if (outcome !== 'asked') return { kind: 'answered', outcome };
  const ledger = findLedgerForMember(db, rule.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (rule.template === null) return { kind: 'notFound' };
  return { kind: 'asked', rule, template: rule.template, ledger };
}

export type AnswerAskResult =
  | { readonly kind: 'recorded'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'skipped'; readonly rule: RecurringRule }
  | AskRefusal;

// [Записать] or a typed amount: records the template, or `amountMinor` in the rule's currency,
// on the due date under `rec:<rule>:<due date>`; the occurrence moves from asked to recorded in
// the same transaction, so a second tap records nothing. [Пропустить] (`skip`) records nothing.
export function answerAsk(
  deps: RecurringDeps,
  input: {
    readonly user: User;
    readonly ruleId: RuleId;
    readonly dueOn: LocalDate;
    readonly now: Date;
    readonly answer:
      { readonly kind: 'record'; readonly amountMinor?: number } | { readonly kind: 'skip' };
    // A typed amount's flow, completed in the same transaction.
    readonly inputKey?: string;
  },
): AnswerAskResult {
  const { db, logger } = deps;
  return db.transaction((): AnswerAskResult => {
    const target = askTarget(deps, input);
    if (input.inputKey !== undefined) completeFlow(deps, input.user, input.inputKey);
    if (target.kind !== 'asked') return target;
    const { rule, ledger } = target;
    if (input.answer.kind === 'skip') {
      answerAskedOccurrence(db, {
        ruleId: rule.id,
        dueOn: input.dueOn,
        outcome: 'skipped',
        expenseId: null,
      });
      logger.info({ ruleId: rule.id, outcome: 'skipped' }, 'recurring answer');
      return { kind: 'skipped', rule };
    }
    const template = {
      ...target.template,
      amountMinor: input.answer.amountMinor ?? target.template.amountMinor,
    };
    const expense = recordOccurrence(deps, {
      rule,
      template,
      ledger,
      author: input.user,
      dueOn: input.dueOn,
      now: input.now,
    });
    answerAskedOccurrence(db, {
      ruleId: rule.id,
      dueOn: input.dueOn,
      outcome: 'recorded',
      expenseId: expense.id,
    });
    logger.info(
      { ruleId: rule.id, expenseId: expense.id, outcome: 'recorded' },
      'recurring answer',
    );
    return { kind: 'recorded', expense, ledger };
  })();
}

// [Другая сумма]: the amount prompt's flow (ADR-0009), while the occurrence is still asked.
export function startAskAmount(
  deps: RecurringDeps,
  input: {
    readonly user: User;
    readonly ruleId: RuleId;
    readonly dueOn: LocalDate;
    readonly now: Date;
  },
): AskTarget | AskRefusal {
  const target = askTarget(deps, input);
  if (target.kind === 'asked') {
    startFlow(
      deps,
      input.user,
      { kind: 'recurringAmount', ruleId: input.ruleId, dueOn: input.dueOn },
      input.now,
    );
  }
  return target;
}

export type AskAmountAnswer =
  | AnswerAskResult
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'invalid'; readonly target: AskTarget };

// A typed answer to [Другая сумма]: an amount in the rule's currency, read by the ADR-0004 parser.
export function answerAskAmount(
  deps: RecurringDeps,
  input: {
    readonly user: User;
    readonly flow: RecurringAmountFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): AskAmountAnswer {
  const { flow } = input;
  const target = askTarget(deps, { user: input.user, ruleId: flow.ruleId, dueOn: flow.dueOn });
  if (target.kind !== 'asked') {
    cancelFlow(deps, input.user);
    return target;
  }
  const amount = parseAmount(input.text.trim(), target.template.currency);
  if (amount.kind !== 'ok') return { kind: 'invalid', target };
  return answerAsk(deps, {
    user: input.user,
    ruleId: flow.ruleId,
    dueOn: flow.dueOn,
    now: input.now,
    answer: { kind: 'record', amountMinor: amount.amountMinor },
    inputKey: input.inputKey,
  });
}

export type RuleChange =
  | { readonly kind: 'changed' | 'unchanged'; readonly rule: RecurringRule }
  | { readonly kind: 'notFound' };

// The author's live rule, else notFound.
export function ownRule(
  { db }: Pick<RecurringDeps, 'db'>,
  user: User,
  ruleId: RuleId,
): RecurringRule | undefined {
  const rule = findRule(db, ruleId);
  return rule?.userId === user.id && rule.deletedAt === null ? rule : undefined;
}

// [Спрашивать перед записью] / [Записывать само]: sets the mode the button names.
export function changeRuleMode(
  deps: RecurringDeps,
  input: { readonly user: User; readonly ruleId: RuleId; readonly mode: RuleMode },
): RuleChange {
  const rule = ownRule(deps, input.user, input.ruleId);
  if (rule === undefined) return { kind: 'notFound' };
  const changed = setRuleMode(deps.db, rule.id, input.mode);
  if (changed) deps.logger.info({ ruleId: rule.id, mode: input.mode }, 'rule mode changed');
  return { kind: changed ? 'changed' : 'unchanged', rule: { ...rule, mode: input.mode } };
}

// Sets deleted_at: the rule never fires again, and the expenses it recorded stay.
export function deleteRule(
  deps: RecurringDeps,
  input: { readonly user: User; readonly ruleId: RuleId; readonly now: Date },
): RuleChange {
  const rule = ownRule(deps, input.user, input.ruleId);
  if (rule === undefined) return { kind: 'notFound' };
  softDeleteRule(deps.db, rule.id, input.now);
  deps.logger.info({ ruleId: rule.id }, 'rule deleted');
  return { kind: 'changed', rule };
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
