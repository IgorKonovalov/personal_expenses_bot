import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { listLedgerExpenses, listLedgerExpensesBetween, type Expense } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findActiveLedger, listMemberNames, type Ledger } from '../db/ledgers.js';
import { listLedgerReceiptItems, type LedgerReceiptItem } from '../db/receiptItems.js';
import { listLedgerReceipts, type ReceiptId } from '../db/receipts.js';
import type { User, UserId } from '../db/users.js';
import {
  exportSpan,
  type ExportExpense,
  type ExportItem,
  type ExportRange,
} from '../domain/export/rows.js';
import { convert } from '../domain/fx.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// /export (ADR-0026): every live expense of a range, resolved into plain rows the export
// writers take, with its receipt's items. It writes nothing. Reads go through the decrypting
// seam, so a sealed ledger that is locked exports nothing and reads as `locked` (ADR-0020).

export interface LedgerExport {
  readonly ledger: Ledger;
  // What the files are named by: `2026-10`, `2026-09`, `2026` or `all`.
  readonly key: string;
  // Ordered by occurred_on, then occurred_at, then id.
  readonly expenses: readonly ExportExpense[];
  // Ordered as their expenses, then by position.
  readonly items: readonly ExportItem[];
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
  return exportOf(deps, { readerId: input.user.id, ledger, timezone }, input.range, input.now);
}

function exportOf(
  deps: Deps,
  source: { readonly readerId: UserId; readonly ledger: Ledger; readonly timezone: string },
  range: ExportRange,
  now: Date,
): LedgerExport | Locked {
  const { db } = deps;
  const { readerId, ledger, timezone } = source;
  const span = exportSpan(range, localDateOf(now, timezone));
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
  const { expenses } = opened;

  const convertedOf = converter(db, ledger, expenses, span.dates);
  const names = listMemberNames(db, ledger.id);
  const receipts = new Map(listLedgerReceipts(db, ledger.id).map((r) => [r.expenseId, r]));
  const itemsByReceipt = groupItems(listLedgerReceiptItems(db, ledger.id));

  const rows: ExportExpense[] = [];
  const items: ExportItem[] = [];
  for (const expense of expenses) {
    const receipt = receipts.get(expense.id);
    const shop = receipt?.sellerName ?? null;
    rows.push({
      id: expense.id,
      occurredOn: expense.occurredOn,
      time: format(new TZDate(expense.occurredAt.getTime(), timezone), 'HH:mm'),
      amount: { amountMinor: expense.amountMinor, currency: expense.currency },
      converted: convertedOf(expense),
      category: expense.category?.name ?? null,
      description: expense.description,
      author: names.get(expense.createdBy) ?? null,
      shop,
      receiptUrl: receipt?.verifyUrl ?? null,
    });
    for (const item of receipt === undefined ? [] : (itemsByReceipt.get(receipt.id) ?? [])) {
      items.push({
        expenseId: expense.id,
        occurredOn: expense.occurredOn,
        shop,
        position: item.position,
        name: item.name,
        quantity: item.quantity,
        total: { amountMinor: item.totalMinor, currency: expense.currency },
      });
    }
  }
  return { ledger, key: span.key, expenses: rows, items };
}

// Each expense in the ledger's currency at the NBS rate of its day (ADR-0022), rounded once per
// expense as the reports do. The rates are read once over the range's days, or over the days of
// the expenses for all time.
function converter(
  db: Deps['db'],
  ledger: Ledger,
  expenses: readonly Expense[],
  dates: { readonly from: LocalDate; readonly to: LocalDate } | undefined,
): (expense: Expense) => ExportExpense['converted'] {
  const from = dates?.from ?? expenses[0]?.occurredOn;
  const to = dates?.to ?? expenses.at(-1)?.occurredOn;
  if (from === undefined || to === undefined) return () => undefined;
  const rateOf = rateLookupBetween(db, from, to);
  return (expense) =>
    convert(
      { amountMinor: expense.amountMinor, currency: expense.currency },
      ledger.defaultCurrency,
      (currency) => rateOf(currency, expense.occurredOn),
    );
}

function groupItems(
  items: readonly LedgerReceiptItem[],
): ReadonlyMap<ReceiptId, readonly LedgerReceiptItem[]> {
  const byReceipt = new Map<ReceiptId, LedgerReceiptItem[]>();
  for (const item of items) {
    const list = byReceipt.get(item.receiptId) ?? [];
    list.push(item);
    byReceipt.set(item.receiptId, list);
  }
  return byReceipt;
}
