import { findLedgerBudget } from '../db/budgets.js';
import { listLedgerExpensesBetween, type Expense } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findPersonalLedger, type Ledger } from '../db/ledgers.js';
import {
  claimKey,
  claimSummaryPush,
  findSummaryPush,
  listClaimedPushes,
  type SummaryKind,
} from '../db/summaryPushes.js';
import {
  listPushTargets,
  setPushOn,
  type PushKind,
  type PushRecipient,
  type User,
  type UserId,
} from '../db/users.js';
import { summarizeConverted, type CurrencySummary } from '../domain/aggregate.js';
import { addDays } from '../domain/dateText.js';
import {
  changeOf,
  periodDeltas,
  topExpenses,
  type Change,
  type CategoryDelta,
  type Ranked,
} from '../domain/deltas.js';
import { convert } from '../domain/fx.js';
import type { Money } from '../domain/money.js';
import {
  budgetPeriodOf,
  monthOf,
  parsePeriod,
  periodKey,
  previous,
  weekOf,
  type DateRange,
} from '../domain/periods.js';
import { dueInstant } from '../domain/schedule.js';
import { localDateOf, parseLocalDate, type LocalDate } from '../domain/time.js';
import { budgetEnd, type BudgetEnd } from './budget.js';
import { isLocked, openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// The summary pushes (ADR-0031): the personal ledger's closed period, reported to its owner at
// 09:00 local on the day after it ends. Each (ledger, kind, period key) is claimed in
// summary_pushes before anything is sent, so it goes out at most once. Groups get none. Logs
// carry the ledger id, the kind and the period key, never a figure.

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// A push whose due instant is older than this is skipped: a long outage, or the deploy that
// brings the pushes, sends no stale reports.
export const CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;

// A closed report period, local dates, both ends inclusive: a calendar month or the payday
// period of the ledger's budget (ADR-0017) for the monthly push, a Monday-to-Sunday week for the
// weekly one.
export interface SummaryPeriod extends DateRange {
  readonly kind: 'month' | 'budget' | 'week';
}

// The report lists this many of the period's largest expenses.
export const TOP_EXPENSES = 3;

export interface DueSummary {
  readonly recipient: PushRecipient;
  readonly ledger: Ledger;
  // The switch that sends it.
  readonly push: PushKind;
  readonly kind: SummaryKind;
  readonly period: SummaryPeriod;
  // The period it is compared against.
  readonly previous: DateRange;
  readonly periodKey: string;
}

// The pushes due at `now` and not yet claimed: for each user with a push on, the most recently
// closed period of their personal ledger, once 09:00 local on the day after it has passed and
// for CATCH_UP_MS after that. A tick reads every recipient, so the statements are fixed: one
// read of the recipients with their ledgers and budgets, one of the claims among the candidates.
// Zones, local dates and due instants are memoized for the call.
export function dueSummaries(deps: Deps, now: Date): DueSummary[] {
  const memo = tickMemo(deps, now);
  const candidates: DueSummary[] = [];
  for (const { recipient, ledger, periodStartDay } of listPushTargets(deps.db)) {
    if (ledger === undefined) continue;
    const timeZone = memo.timezone(recipient.user, ledger);
    const today = memo.today(timeZone);
    const own = [
      ...(recipient.monthly ? [memo.monthly(periodStartDay, today)] : []),
      ...(recipient.weekly ? [memo.weekly(today)] : []),
    ];
    for (const closed of own) {
      const dueAt = memo.dueAt(closed.period.to, timeZone);
      if (now.getTime() < dueAt || now.getTime() - dueAt > CATCH_UP_MS) continue;
      candidates.push({ recipient, ledger, ...closed });
    }
  }
  const claimed = listClaimedPushes(
    deps.db,
    candidates.map((c) => ({ ledgerId: c.ledger.id, kind: c.kind, periodKey: c.periodKey })),
  );
  return candidates.filter((c) => !claimed.has(claimKey(c.ledger.id, c.kind, c.periodKey)));
}

// Per-call memos: most recipients share a handful of zones, local dates and start days, and
// resolving a zone builds an Intl.DateTimeFormat.
function tickMemo(deps: Deps, now: Date) {
  // Raw stored zone -> resolved zone, only for a zone that resolved to itself: an invalid one
  // goes through effectiveTimezone every time, so its fallback warn names each user or ledger.
  const zones = new Map<string, string>();
  const todays = new Map<string, LocalDate>();
  const dueAts = new Map<string, number>();
  const monthlies = new Map<string, ClosedPeriod>();
  const weeklies = new Map<LocalDate, ClosedPeriod>();
  return {
    monthly: (startDay: number, today: LocalDate): ClosedPeriod => {
      const key = `${today} ${startDay}`;
      let closed = monthlies.get(key);
      if (closed === undefined) {
        closed = monthly(startDay, today);
        monthlies.set(key, closed);
      }
      return closed;
    },
    weekly: (today: LocalDate): ClosedPeriod => {
      let closed = weeklies.get(today);
      if (closed === undefined) {
        closed = weekly(today);
        weeklies.set(today, closed);
      }
      return closed;
    },
    timezone: (user: User, ledger: Ledger): string => {
      const raw = ledger.timezone ?? user.timezone;
      const known = zones.get(raw);
      if (known !== undefined) return known;
      const resolved = effectiveTimezone(deps, user, ledger);
      if (resolved === raw) zones.set(raw, resolved);
      return resolved;
    },
    today: (timeZone: string): LocalDate => {
      let today = todays.get(timeZone);
      if (today === undefined) {
        today = localDateOf(now, timeZone);
        todays.set(timeZone, today);
      }
      return today;
    },
    // 09:00 local on the day after `periodEnd`.
    dueAt: (periodEnd: LocalDate, timeZone: string): number => {
      const key = `${periodEnd} ${timeZone}`;
      let at = dueAts.get(key);
      if (at === undefined) {
        at = dueInstant(addDays(periodEnd, 1), timeZone).getTime();
        dueAts.set(key, at);
      }
      return at;
    },
  };
}

// A due summary without its recipient and ledger.
type ClosedPeriod = Omit<DueSummary, 'recipient' | 'ledger'>;

// The period before the one holding `today`: the budget's payday period when the ledger has a
// budget starting on a day other than the 1st, keyed by its first day, else the calendar month.
function monthly(startDay: number, today: LocalDate): ClosedPeriod {
  const base = { push: 'monthly', kind: 'period' } as const;
  if (startDay !== 1) {
    const closed = budgetPeriodOf(addDays(budgetPeriodOf(today, startDay).from, -1), startDay);
    return {
      ...base,
      period: { kind: 'budget', from: closed.from, to: closed.to },
      previous: budgetPeriodOf(addDays(closed.from, -1), startDay),
      periodKey: closed.from,
    };
  }
  const closed = previous(monthOf(today));
  return {
    ...base,
    period: { kind: 'month', from: closed.from, to: closed.to },
    previous: previous(closed),
    periodKey: periodKey(closed),
  };
}

// The ISO week before the one holding `today`, keyed by its Monday.
function weekly(today: LocalDate): ClosedPeriod {
  const closed = previous(weekOf(today));
  return {
    push: 'weekly',
    kind: 'week',
    period: { kind: 'week', from: closed.from, to: closed.to },
    previous: previous(closed),
    periodKey: periodKey(closed),
  };
}

// Claims the push: `sent` when the period has expenses and the report is to go out, `empty`
// when it has none and nothing is sent. Undefined when another tick claimed it first. A sealed
// ledger's rows are counted without opening them.
export function claimSummary(deps: Deps, due: DueSummary, now: Date): 'sent' | 'empty' | undefined {
  const { db, logger } = deps;
  return db.transaction((): 'sent' | 'empty' | undefined => {
    const rows = listLedgerExpensesBetween(db, {
      ledgerId: due.ledger.id,
      memberId: due.recipient.user.id,
      from: due.period.from,
      to: due.period.to,
    });
    const outcome = rows.length > 0 ? 'sent' : 'empty';
    const claimed = claimSummaryPush(db, {
      ledgerId: due.ledger.id,
      kind: due.kind,
      periodKey: due.periodKey,
      outcome,
      createdAt: now,
    });
    if (!claimed) return undefined;
    logger.info(
      { ledgerId: due.ledger.id, kind: due.kind, periodKey: due.periodKey, outcome },
      'summary push',
    );
    return outcome;
  })();
}

// The converted block against the period before: its total's change and each category's.
export interface ConvertedReport {
  readonly currency: CurrencySummary['currency'];
  readonly totalMinor: number;
  readonly change: Change;
  readonly lines: readonly CategoryDelta[];
}

export interface PeriodReport {
  readonly ledger: Ledger;
  readonly period: SummaryPeriod;
  // Everything with a rate, in the ledger's currency (ADR-0022); undefined when nothing converts.
  readonly converted: ConvertedReport | undefined;
  // The original totals of the foreign expenses inside `converted`, alphabetically.
  readonly convertedFrom: readonly Money[];
  // Each currency with no rate, never added to anything and with no change shown.
  readonly unconverted: readonly CurrencySummary[];
  // How the budget's limit ended over the period; absent without a limit, and for a week.
  readonly budget?: BudgetEnd;
  // The TOP_EXPENSES largest expenses by converted amount; one with no rate isn't ranked. Empty
  // for a week.
  readonly top: readonly TopExpense[];
}

export interface TopExpense extends Ranked {
  readonly occurredOn: LocalDate;
  // As recorded.
  readonly money: Money;
  // In the ledger's currency: `convertedMinor`.
  readonly currency: Money['currency'];
  readonly description: string;
}

// The period's report for `readerId`, compared with `previous`. `locked` for a sealed ledger
// this process holds no key for.
export function periodReport(
  deps: Deps,
  input: {
    readonly ledger: Ledger;
    readonly readerId: UserId;
    readonly period: SummaryPeriod;
    readonly previous: DateRange;
  },
): PeriodReport | Locked {
  const { ledger } = input;
  const current = openedBetween(deps, ledger, input.readerId, input.period);
  if (!Array.isArray(current)) return current;
  const before = openedBetween(deps, ledger, input.readerId, input.previous);
  if (!Array.isArray(before)) return before;
  const rateOf = rateLookupBetween(deps.db, input.period.from, input.period.to);
  const now = summarizeConverted(current, ledger.defaultCurrency, rateOf);
  const then = summarizeConverted(
    before,
    ledger.defaultCurrency,
    rateLookupBetween(deps.db, input.previous.from, input.previous.to),
  );
  const week = input.period.kind === 'week';
  const budget = week
    ? undefined
    : budgetEnd(deps, { ledger, readerId: input.readerId, period: input.period });
  if (isLocked(budget)) return budget;
  const ranked = (week ? [] : current).flatMap((expense): TopExpense[] => {
    const converted = convert(expense, ledger.defaultCurrency, (currency) =>
      rateOf(currency, expense.occurredOn),
    );
    if (converted === undefined) return [];
    return [
      {
        id: expense.id,
        occurredAt: expense.occurredAt,
        occurredOn: expense.occurredOn,
        convertedMinor: converted.amountMinor,
        currency: ledger.defaultCurrency,
        money: { amountMinor: expense.amountMinor, currency: expense.currency },
        description: expense.description,
      },
    ];
  });
  return {
    ...(budget === undefined ? {} : { budget }),
    top: topExpenses(ranked, TOP_EXPENSES),
    ledger,
    period: input.period,
    converted:
      now.converted === undefined
        ? undefined
        : {
            currency: now.converted.currency,
            totalMinor: now.converted.totalMinor,
            change: changeOf(then.converted?.totalMinor ?? 0, now.converted.totalMinor),
            lines: periodDeltas(now.converted.lines, then.converted?.lines ?? []),
          },
    convertedFrom: now.convertedFrom,
    unconverted: now.unconverted,
  };
}

function openedBetween(
  deps: Deps,
  ledger: Ledger,
  readerId: UserId,
  range: DateRange,
): Expense[] | Locked {
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesBetween(deps.db, {
      ledgerId: ledger.id,
      memberId: readerId,
      from: range.from,
      to: range.to,
    }),
  );
  return opened.kind === 'locked' ? opened : opened.expenses;
}

// [Показать] under a locked ledger's push: the report of the push the user's personal ledger was
// sent under that key, read now. Undefined when no such push was sent; `locked` while the ledger
// still is.
export function shownSummary(
  deps: Deps,
  input: { readonly user: User; readonly push: PushKind; readonly periodKey: string },
): PeriodReport | Locked | undefined {
  const ledger = findPersonalLedger(deps.db, input.user.id);
  if (ledger === undefined) return undefined;
  const kind: SummaryKind = input.push === 'weekly' ? 'week' : 'period';
  if (findSummaryPush(deps.db, ledger.id, kind, input.periodKey) !== 'sent') return undefined;
  const periods = periodsOfKey(deps, ledger, kind, input.periodKey);
  if (periods === undefined) return undefined;
  return periodReport(deps, { ledger, readerId: input.user.id, ...periods });
}

// A push's period and the one before it, back from its key: a week by its Monday, a calendar
// month by `YYYY-MM`, a budget period by its first day under the budget's start day (that day of
// the month when the start day has moved since).
function periodsOfKey(
  deps: Deps,
  ledger: Ledger,
  kind: SummaryKind,
  key: string,
): { readonly period: SummaryPeriod; readonly previous: DateRange } | undefined {
  if (kind === 'week') {
    const week = parsePeriod('week', key);
    return week === undefined
      ? undefined
      : { period: { kind: 'week', from: week.from, to: week.to }, previous: previous(week) };
  }
  const month = parsePeriod('month', key);
  if (month !== undefined) {
    return { period: { kind: 'month', from: month.from, to: month.to }, previous: previous(month) };
  }
  const from = parseLocalDate(key);
  if (from === undefined) return undefined;
  const current = findLedgerBudget(deps.db, ledger.id)?.periodStartDay;
  const startDay =
    current !== undefined && budgetPeriodOf(from, current).from === from
      ? current
      : Number(from.slice(8, 10));
  const closed = budgetPeriodOf(from, startDay);
  return {
    period: { kind: 'budget', from: closed.from, to: closed.to },
    previous: budgetPeriodOf(addDays(closed.from, -1), startDay),
  };
}

// [Отключить] on a push: that push's switch off. False when it already was.
export function turnSummaryPushOff(deps: Deps, user: User, push: PushKind): boolean {
  const changed = setPushOn(deps.db, user.id, push, false);
  if (changed) deps.logger.info({ userId: user.id, push }, 'summary push off');
  return changed;
}
