import { listLedgerExpensesBetween, type Expense } from '../db/expenses.js';
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
  summarizeByAuthor,
  summarizeByCurrencyAndCategory,
  type CurrencySummary,
} from '../domain/aggregate.js';
import type { Money } from '../domain/money.js';
import { next, periodOf, previous, type Period } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { effectiveTimezone, resolveLedgerTimezone, type RecordDeps } from './recordExpense.js';

// One member's spending in a shared ledger: a total per currency, never added together.
export interface PersonTotals {
  // The member's stored display name; null for one never seen in a group.
  readonly name: string | null;
  readonly totals: readonly Money[];
}

export interface PeriodSummary {
  readonly ledger: Ledger;
  readonly period: Period;
  // The ledger default currency first, then the others alphabetically; empty for no expenses.
  readonly currencies: readonly CurrencySummary[];
  readonly previous: Period;
  // Absent for the period holding the ledger's today: there is nothing after it yet.
  readonly next?: Period;
  // A group report's per-person section, largest default-currency total first.
  readonly people?: readonly PersonTotals[];
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'>;

// The active ledger's current week or month, in the ledger's effective timezone (ADR-0015).
export function currentPeriodSummary(
  deps: Deps,
  input: { readonly user: User; readonly kind: Period['kind']; readonly now: Date },
): PeriodSummary {
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
): PeriodSummary | undefined {
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
  deps: Deps,
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
  return summarize(deps, bound.readerId, bound.ledger, period, today, true);
}

// Rows by occurred_on in the period; sums in the domain (ADR-0002).
function summarize(
  { db }: Deps,
  readerId: UserId,
  ledger: Ledger,
  period: Period,
  today: LocalDate,
  withPeople = false,
): PeriodSummary {
  const expenses = listLedgerExpensesBetween(db, {
    ledgerId: ledger.id,
    memberId: readerId,
    from: period.from,
    to: period.to,
  });
  const following = next(period);
  return {
    ledger,
    period,
    currencies: summarizeByCurrencyAndCategory(expenses, ledger.defaultCurrency),
    previous: previous(period),
    ...(following.from > today ? {} : { next: following }),
    ...(withPeople ? { people: peopleOf(db, ledger, expenses) } : {}),
  };
}

export function peopleOf(
  db: Deps['db'],
  ledger: Ledger,
  expenses: readonly Expense[],
): PersonTotals[] {
  const names = listMemberNames(db, ledger.id);
  return summarizeByAuthor(expenses, ledger.defaultCurrency).map(({ authorId, totals }) => ({
    name: names.get(authorId as UserId) ?? null,
    totals,
  }));
}
