import { listLedgerExpenses, listLedgerExpensesBetween } from '../db/expenses.js';
import { findActiveLedger, type Ledger } from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { exportSpan, type ExportExpense, type ExportRange } from '../domain/export/rows.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// /export (ADR-0026): every live expense of a range, resolved into plain rows the export
// writers take. It writes nothing. Reads go through the decrypting seam, so a sealed ledger that
// is locked exports nothing and reads as `locked` (ADR-0020).

export interface LedgerExport {
  readonly ledger: Ledger;
  // What the files are named by: `2026-10`, `2026-09`, `2026` or `all`.
  readonly key: string;
  // Ordered by occurred_on, then occurred_at, then id.
  readonly expenses: readonly ExportExpense[];
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// The user's active ledger, with the range computed from today in its effective timezone.
export function exportActiveLedger(
  deps: Deps,
  input: { readonly user: User; readonly range: ExportRange; readonly now: Date },
): LedgerExport | Locked {
  const ledger = findActiveLedger(deps.db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const timezone = effectiveTimezone(deps, input.user, ledger);
  return exportOf(deps, input.user.id, ledger, input.range, localDateOf(input.now, timezone));
}

function exportOf(
  deps: Deps,
  readerId: UserId,
  ledger: Ledger,
  range: ExportRange,
  today: LocalDate,
): LedgerExport | Locked {
  const { db } = deps;
  const span = exportSpan(range, today);
  const stored =
    span.dates === undefined
      ? listLedgerExpenses(db, { ledgerId: ledger.id, memberId: readerId })
      : listLedgerExpensesBetween(db, {
          ledgerId: ledger.id,
          memberId: readerId,
          from: span.dates.from,
          to: span.dates.to,
        });
  const opened = openExpenses(deps, ledger.id, stored);
  if (opened.kind === 'locked') return opened;
  return {
    ledger,
    key: span.key,
    expenses: opened.expenses.map((expense) => ({
      id: expense.id,
      occurredOn: expense.occurredOn,
      amount: { amountMinor: expense.amountMinor, currency: expense.currency },
      category: expense.category?.name ?? null,
      description: expense.description,
    })),
  };
}
