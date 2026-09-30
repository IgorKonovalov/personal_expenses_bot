import { listLedgerExpensesBetween } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { summarizeByCurrencyAndCategory, type CurrencySummary } from '../domain/aggregate.js';
import { next, periodOf, previous, type Period } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import type { RecordDeps } from './recordExpense.js';
import { resolveUserTimezone } from './settings.js';

export interface PeriodSummary {
  readonly ledger: Ledger;
  readonly period: Period;
  // The ledger default currency first, then the others alphabetically; empty for no expenses.
  readonly currencies: readonly CurrencySummary[];
  readonly previous: Period;
  // Absent for the period holding the user's today: there is nothing after it yet.
  readonly next?: Period;
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'>;

// The active ledger's current week or month, in the user's timezone.
export function currentPeriodSummary(
  deps: Deps,
  input: { readonly user: User; readonly kind: Period['kind']; readonly now: Date },
): PeriodSummary {
  const ledger = findActiveLedger(deps.db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const today = localDateOf(input.now, resolveUserTimezone(deps, input.user));
  return summarize(deps, input.user, ledger, periodOf(input.kind, today), today);
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
  const today = localDateOf(input.now, resolveUserTimezone(deps, input.user));
  if (input.period.from > today) return undefined;
  return summarize(deps, input.user, ledger, input.period, today);
}

// Rows by occurred_on in the period; sums in the domain (ADR-0002).
function summarize(
  { db }: Deps,
  user: User,
  ledger: Ledger,
  period: Period,
  today: LocalDate,
): PeriodSummary {
  const expenses = listLedgerExpensesBetween(db, {
    ledgerId: ledger.id,
    memberId: user.id,
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
  };
}
