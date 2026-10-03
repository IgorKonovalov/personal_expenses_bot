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
import type { SealedReceipt } from '../domain/sealing.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import {
  foldedReceipt,
  isLocked,
  isSealedLedger,
  ledgerIsLocked,
  LOCKED,
  openExpenses,
  type KeyDeps,
  type Locked,
} from './ledgerKeys.js';
import { boundGroupLedger } from './periodSummary.js';
import { effectiveTimezone, resolveLedgerTimezone, type RecordDeps } from './recordExpense.js';

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

// The ledger a group chat is bound to, in the ledger's timezone, read through the binder's
// membership (ADR-0014): any member of the chat may export it. Undefined for an unbound chat.
export function exportGroupLedger(
  deps: Deps,
  input: { readonly chatId: number; readonly range: ExportRange; readonly now: Date },
): LedgerExport | undefined {
  const bound = boundGroupLedger(deps, input.chatId);
  if (bound === undefined) return undefined;
  const { ledger } = bound;
  const timezone =
    ledger.timezone === null
      ? deps.defaultTimezone
      : resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  const result = exportOf(
    deps,
    { readerId: bound.readerId, ledger, timezone },
    input.range,
    input.now,
  );
  // A shared ledger is never sealed.
  if (isLocked(result)) throw new Error(`group ledger ${ledger.id} is sealed`);
  return result;
}

// What the /export picker shows for the user's active ledger: `sealed` for a sealed ledger
// that is unlocked, which the picker warns the file is a plaintext copy of; a locked one exports
// nothing.
export function activeExportState(
  deps: Pick<KeyDeps, 'db' | 'keys'>,
  user: User,
): { readonly kind: 'open'; readonly sealed: boolean } | Locked {
  const ledger = findActiveLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  if (!isSealedLedger(deps, ledger.id)) return { kind: 'open', sealed: false };
  return ledgerIsLocked(deps, ledger.id) ? LOCKED : { kind: 'open', sealed: true };
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
  const receiptOf = receiptLookup(deps, ledger);

  const rows: ExportExpense[] = [];
  const items: ExportItem[] = [];
  for (const expense of expenses) {
    const receipt = receiptOf(expense);
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
    for (const [i, item] of (receipt?.items ?? []).entries()) {
      items.push({
        expenseId: expense.id,
        occurredOn: expense.occurredOn,
        shop,
        position: i + 1,
        name: item.name,
        quantity: item.quantity,
        total: { amountMinor: item.totalMinor, currency: expense.currency },
      });
    }
  }
  return { ledger, key: span.key, expenses: rows, items };
}

// An expense's receipt with its items by position. A plaintext ledger's come from the receipt
// tables, read once; a sealed ledger's were folded into each row's payload when it was sealed,
// and open with the unlocked key (ADR-0020).
function receiptLookup(
  deps: Deps,
  ledger: Ledger,
): (expense: Expense) => SealedReceipt | undefined {
  if (isSealedLedger(deps, ledger.id)) return (expense) => foldedReceipt(deps, expense.id);
  const receipts = new Map(listLedgerReceipts(deps.db, ledger.id).map((r) => [r.expenseId, r]));
  const itemsByReceipt = groupItems(listLedgerReceiptItems(deps.db, ledger.id));
  return (expense) => {
    const receipt = receipts.get(expense.id);
    if (receipt === undefined) return undefined;
    return {
      sellerName: receipt.sellerName,
      verifyUrl: receipt.verifyUrl,
      items: itemsByReceipt.get(receipt.id) ?? [],
    };
  };
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
