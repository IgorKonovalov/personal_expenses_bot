import { listLedgerExpensesOn } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import {
  findActiveLedger,
  findLedgerForMember,
  listMemberNames,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { summarizeConverted } from '../domain/aggregate.js';
import type { Money } from '../domain/money.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import type { CategoryExpense } from './periodCategory.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// /today's [Траты] (Plan 0048): one day's expenses of a ledger, newest first, under the day's
// totals as /today shows them.

export interface DayExpenses {
  readonly ledger: Ledger;
  readonly date: LocalDate;
  // The ledger's current local date, in its effective timezone.
  readonly today: LocalDate;
  // The ledger currency first, holding every expense converted at the day's rate (ADR-0022),
  // then each currency with no rate. Empty for a day with no expenses.
  readonly totals: readonly Money[];
  // The original totals of the foreign expenses converted into the first total.
  readonly convertedFrom: readonly Money[];
  // Newest first: by occurred_at, then id.
  readonly expenses: readonly CategoryExpense[];
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// The expenses of `ledgerId` whose stored occurred_on is `date`. Undefined once the user is no
// longer a member, or for a date after the ledger's today. A sealed ledger that is locked reads as
// `locked` (ADR-0020).
export function dayExpenses(
  deps: Deps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly date: LocalDate;
    readonly now: Date;
  },
): DayExpenses | Locked | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  return ledger === undefined ? undefined : readDay(deps, input, ledger);
}

// The same for the user's active ledger at this moment.
export function activeDayExpenses(
  deps: Deps,
  input: { readonly user: User; readonly date: LocalDate; readonly now: Date },
): DayExpenses | Locked | undefined {
  const ledger = findActiveLedger(deps.db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  return readDay(deps, input, ledger);
}

function readDay(
  deps: Deps,
  input: { readonly user: User; readonly date: LocalDate; readonly now: Date },
  ledger: Ledger,
): DayExpenses | Locked | undefined {
  const { db } = deps;
  const today = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  if (input.date > today) return undefined;
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesOn(db, {
      ledgerId: ledger.id,
      memberId: input.user.id,
      occurredOn: input.date,
    }),
  );
  if (opened.kind === 'locked') return opened;
  const summary = summarizeConverted(
    opened.expenses,
    ledger.defaultCurrency,
    rateLookupBetween(db, input.date, input.date),
  );
  const blocks =
    summary.converted === undefined
      ? summary.unconverted
      : [summary.converted, ...summary.unconverted];
  const names = ledger.kind === 'shared' ? listMemberNames(db, ledger.id) : undefined;
  return {
    ledger,
    date: input.date,
    today,
    totals: blocks.map((b) => ({ currency: b.currency, amountMinor: b.totalMinor })),
    convertedFrom: summary.convertedFrom,
    // The rows come oldest first by the same keys.
    expenses: [...opened.expenses].reverse().map((expense) => ({
      id: expense.id,
      occurredOn: expense.occurredOn,
      money: { amountMinor: expense.amountMinor, currency: expense.currency },
      description: expense.description,
      ...(names === undefined ? {} : { author: names.get(expense.createdBy) ?? null }),
    })),
  };
}
