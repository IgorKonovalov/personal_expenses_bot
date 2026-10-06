import { listLedgerExpenses, type Expense } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findActiveLedger, type Ledger } from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import type { RateOf } from '../domain/fx.js';
import { summarizeTags, type TagTotal } from '../domain/tags.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import type { RecordDeps } from './recordExpense.js';

type Deps = Pick<RecordDeps, 'db'> & Pick<KeyDeps, 'keys'>;

export interface TagList {
  readonly ledger: Ledger;
  // Most recently used first; empty when no live expense carries a tag.
  readonly tags: readonly TagTotal[];
}

// The active ledger's tags with their all-time totals in the ledger's currency (ADR-0029): the
// ledger's live expenses are read through the decrypting seam and grouped in the domain, never
// in SQL. A sealed ledger that is locked reads as `locked` (ADR-0020).
export function activeLedgerTags(deps: Deps, user: User): TagList | Locked {
  const ledger = findActiveLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return ledgerTags(deps, user.id, ledger);
}

function ledgerTags(deps: Deps, readerId: UserId, ledger: Ledger): TagList | Locked {
  const opened = liveExpenses(deps, readerId, ledger);
  if (opened.kind === 'locked') return opened;
  const { expenses, rateOf } = opened;
  return { ledger, tags: summarizeTags(expenses, ledger.defaultCurrency, rateOf) };
}

// Every live expense of the ledger, opened, and a rate lookup over their days.
function liveExpenses(
  deps: Deps,
  readerId: UserId,
  ledger: Ledger,
):
  | { readonly kind: 'open'; readonly expenses: readonly Expense[]; readonly rateOf: RateOf }
  | Locked {
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpenses(deps.db, { ledgerId: ledger.id, memberId: readerId }),
  );
  if (opened.kind === 'locked') return opened;
  const { expenses } = opened;
  const first = expenses[0]?.occurredOn;
  const last = expenses.at(-1)?.occurredOn;
  const rateOf: RateOf =
    first === undefined || last === undefined
      ? () => undefined
      : rateLookupBetween(deps.db, first, last);
  return { kind: 'open', expenses, rateOf };
}
