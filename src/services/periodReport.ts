import { listLedgerExpensesBetween, type Expense } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findPersonalLedger, type Ledger } from '../db/ledgers.js';
import { claimSummaryPush, findSummaryPush, type SummaryKind } from '../db/summaryPushes.js';
import {
  listPushRecipients,
  setPushOn,
  type PushKind,
  type PushRecipient,
  type User,
  type UserId,
} from '../db/users.js';
import { summarizeConverted, type CurrencySummary } from '../domain/aggregate.js';
import { addDays } from '../domain/dateText.js';
import { changeOf, periodDeltas, type Change, type CategoryDelta } from '../domain/deltas.js';
import type { Money } from '../domain/money.js';
import { monthOf, periodKey, previous, type DateRange } from '../domain/periods.js';
import { dueInstant } from '../domain/schedule.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// The summary pushes (ADR-0031): the personal ledger's closed period, reported to its owner at
// 09:00 local on the day after it ends. Each (ledger, kind, period key) is claimed in
// summary_pushes before anything is sent, so it goes out at most once. Groups get none. Logs
// carry the ledger id, the kind and the period key, never a figure.

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// A push whose due instant is older than this is skipped: a long outage, or the deploy that
// brings the pushes, sends no stale reports.
export const CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;

// A closed report period, local dates, both ends inclusive: a calendar month.
export interface SummaryPeriod extends DateRange {
  readonly kind: 'month';
}

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
// for CATCH_UP_MS after that.
export function dueSummaries(deps: Deps, now: Date): DueSummary[] {
  const due: DueSummary[] = [];
  for (const recipient of listPushRecipients(deps.db)) {
    const ledger = findPersonalLedger(deps.db, recipient.user.id);
    if (ledger === undefined) continue;
    const timeZone = effectiveTimezone(deps, recipient.user, ledger);
    const today = localDateOf(now, timeZone);
    const candidates = recipient.monthly ? [monthly(recipient, ledger, today)] : [];
    for (const candidate of candidates) {
      const dueAt = dueInstant(addDays(candidate.period.to, 1), timeZone).getTime();
      if (now.getTime() < dueAt || now.getTime() - dueAt > CATCH_UP_MS) continue;
      if (findSummaryPush(deps.db, ledger.id, candidate.kind, candidate.periodKey) !== undefined) {
        continue;
      }
      due.push(candidate);
    }
  }
  return due;
}

// The calendar month before the one holding `today`.
function monthly(recipient: PushRecipient, ledger: Ledger, today: LocalDate): DueSummary {
  const closed = previous(monthOf(today));
  return {
    recipient,
    ledger,
    push: 'monthly',
    kind: 'period',
    period: { kind: 'month', from: closed.from, to: closed.to },
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
  const now = summarizeConverted(
    current,
    ledger.defaultCurrency,
    rateLookupBetween(deps.db, input.period.from, input.period.to),
  );
  const then = summarizeConverted(
    before,
    ledger.defaultCurrency,
    rateLookupBetween(deps.db, input.previous.from, input.previous.to),
  );
  return {
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

// [Отключить] on a push: that push's switch off. False when it already was.
export function turnSummaryPushOff(deps: Deps, user: User, push: PushKind): boolean {
  const changed = setPushOn(deps.db, user.id, push, false);
  if (changed) deps.logger.info({ userId: user.id, push }, 'summary push off');
  return changed;
}
