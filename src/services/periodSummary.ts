import { listLedgerExpensesBetween, type Expense } from '../db/expenses.js';
import { isLocked, openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findLedgerChat } from '../db/ledgerChats.js';
import {
  findActiveLedger,
  findLedgerById,
  findLedgerForMember,
  listMemberNames,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import {
  summarizeByAuthorConverted,
  summarizeConverted,
  type CurrencySummary,
} from '../domain/aggregate.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { RateOf } from '../domain/fx.js';
import type { Money } from '../domain/money.js';
import { next, periodOf, previous, type Period } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { effectiveTimezone, resolveLedgerTimezone, type RecordDeps } from './recordExpense.js';

// One member's spending in a shared ledger: the total converted into the ledger's currency
// first, then each currency with no rate, never added to it (ADR-0022).
export interface PersonTotals {
  // The member's stored display name; null for one never seen in a group.
  readonly name: string | null;
  readonly totals: readonly Money[];
  // Present when the first total holds converted foreign spending.
  readonly converted?: true;
}

export interface PeriodSummary {
  readonly ledger: Ledger;
  readonly period: Period;
  // The ledger default currency first, holding every expense converted into it at the NBS rate
  // of its day (ADR-0022), then each currency with no rate alphabetically; empty for no
  // expenses.
  readonly currencies: readonly CurrencySummary[];
  // The original totals of the foreign expenses converted into the first block, alphabetically.
  readonly convertedFrom: readonly Money[];
  // The currencies of the blocks after the first that have no rate.
  readonly unconverted: readonly CurrencyCode[];
  readonly previous: Period;
  // Absent for the period holding the ledger's today: there is nothing after it yet.
  readonly next?: Period;
  // A group report's per-person section, largest converted total first.
  readonly people?: readonly PersonTotals[];
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// The active ledger's current week or month, in the ledger's effective timezone (ADR-0015). A
// sealed ledger that is locked reads as `locked` (ADR-0020).
export function currentPeriodSummary(
  deps: Deps,
  input: { readonly user: User; readonly kind: Period['kind']; readonly now: Date },
): PeriodSummary | Locked {
  const ledger = findActiveLedger(deps.db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const today = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  return summarize(deps, input.user.id, ledger, periodOf(input.kind, today), today);
}

// A paged-to period of the ledger a summary screen was opened on, which need not be the active
// one (ADR-0011). Undefined once the user is no longer a member, or for a period that starts
// after today.
export function ledgerPeriodSummary(
  deps: Deps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly period: Period;
    readonly now: Date;
  },
): PeriodSummary | Locked | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  const today = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  if (input.period.from > today) return undefined;
  return summarize(deps, input.user.id, ledger, input.period, today);
}

// The ledger a group chat is actively bound to, read through its binding (ADR-0014): anyone in
// the chat sees the group's report, so reads go through the binder's membership, not the
// viewer's. Undefined for an unbound or inactive chat.
export function boundGroupLedger(
  deps: Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'>,
  chatId: number,
):
  | { readonly ledger: Ledger; readonly readerId: UserId; readonly today: (now: Date) => LocalDate }
  | undefined {
  const binding = findLedgerChat(deps.db, 'telegram', String(chatId));
  if (binding === undefined || !binding.active) return undefined;
  const ledger = findLedgerById(deps.db, binding.ledgerId);
  if (ledger === undefined) return undefined;
  const timezone =
    ledger.timezone === null
      ? deps.defaultTimezone
      : resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  return { ledger, readerId: binding.boundBy, today: (now) => localDateOf(now, timezone) };
}

// A bound group's week or month in the ledger's timezone, with the per-person section. `period`
// pages statelessly; without it, the period holding the ledger's today. Undefined for an unbound
// chat, or a period that starts after today.
export function groupPeriodSummary(
  deps: Deps,
  input: {
    readonly chatId: number;
    readonly kind: Period['kind'];
    readonly period?: Period;
    readonly now: Date;
  },
): PeriodSummary | undefined {
  const bound = boundGroupLedger(deps, input.chatId);
  if (bound === undefined) return undefined;
  const today = bound.today(input.now);
  const period = input.period ?? periodOf(input.kind, today);
  if (period.from > today) return undefined;
  const summary = summarize(deps, bound.readerId, bound.ledger, period, today, true);
  // A shared ledger is never sealed.
  if (isLocked(summary)) throw new Error(`group ledger ${bound.ledger.id} is sealed`);
  return summary;
}

// Rows by occurred_on in the period; converts and sums in the domain (ADR-0002, ADR-0022).
function summarize(
  deps: Deps,
  readerId: UserId,
  ledger: Ledger,
  period: Period,
  today: LocalDate,
  withPeople = false,
): PeriodSummary | Locked {
  const { db } = deps;
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesBetween(db, {
      ledgerId: ledger.id,
      memberId: readerId,
      from: period.from,
      to: period.to,
    }),
  );
  if (opened.kind === 'locked') return opened;
  const { expenses } = opened;
  const following = next(period);
  const rateOf = rateLookupBetween(db, period.from, period.to);
  const { converted, convertedFrom, unconverted } = summarizeConverted(
    expenses,
    ledger.defaultCurrency,
    rateOf,
  );
  return {
    ledger,
    period,
    currencies: converted === undefined ? unconverted : [converted, ...unconverted],
    convertedFrom,
    unconverted: unconverted.map((c) => c.currency),
    previous: previous(period),
    ...(following.from > today ? {} : { next: following }),
    ...(withPeople ? { people: peopleOf(db, ledger, expenses, rateOf) } : {}),
  };
}

// Each member's totals in the ledger's currency, the largest converted total first.
export function peopleOf(
  db: Deps['db'],
  ledger: Ledger,
  expenses: readonly Expense[],
  rateOf: RateOf,
): PersonTotals[] {
  const names = listMemberNames(db, ledger.id);
  return summarizeByAuthorConverted(expenses, ledger.defaultCurrency, rateOf).map(
    ({ authorId, converted, anyConverted, unconverted }) => ({
      name: names.get(authorId as UserId) ?? null,
      totals: converted === undefined ? unconverted : [converted, ...unconverted],
      ...(anyConverted ? { converted: true as const } : {}),
    }),
  );
}
