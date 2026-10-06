import type { FetchedItem } from '../domain/receipts/types.js';
import type { Db } from './connection.js';
import type { ExpenseId } from './expenses.js';
import type { LedgerId } from './ledgers.js';
import type { ReceiptId } from './receipts.js';

// A receipt's line items, numbered from 1 in the order the tax site lists them. Insert them in
// the transaction that marks the receipt fetched: a second insert would hit the primary key.
export function insertReceiptItems(
  db: Db,
  receiptId: ReceiptId,
  items: readonly FetchedItem[],
): void {
  const insert = db.prepare<[string, number, string, string, number]>(
    `INSERT INTO receipt_items (receipt_id, position, name, quantity, total_minor)
     VALUES (?, ?, ?, ?, ?)`,
  );
  items.forEach((item, index) => {
    insert.run(receiptId, index + 1, item.name, item.quantity, item.totalMinor);
  });
}

export function listReceiptItems(db: Db, receiptId: ReceiptId): FetchedItem[] {
  return db
    .prepare<[string], { name: string; quantity: string; total_minor: number }>(
      `SELECT name, quantity, total_minor FROM receipt_items
        WHERE receipt_id = ? ORDER BY position`,
    )
    .all(receiptId)
    .map((row) => ({ name: row.name, quantity: row.quantity, totalMinor: row.total_minor }));
}

export interface LedgerReceiptItem extends FetchedItem {
  readonly receiptId: ReceiptId;
  readonly position: number;
}

// The items of every receipt behind the ledger's expenses, deleted expenses included, by
// receipt and then position: what an export joins to the expenses it exports.
export function listLedgerReceiptItems(db: Db, ledgerId: LedgerId): LedgerReceiptItem[] {
  return db
    .prepare<
      [string],
      { receipt_id: string; position: number; name: string; quantity: string; total_minor: number }
    >(
      `SELECT i.receipt_id, i.position, i.name, i.quantity, i.total_minor
         FROM receipt_items i
         JOIN receipts r ON r.id = i.receipt_id
         JOIN expenses e ON e.id = r.expense_id
        WHERE e.ledger_id = ?
        ORDER BY i.receipt_id, i.position`,
    )
    .all(ledgerId)
    .map((row) => ({
      receiptId: row.receipt_id as ReceiptId,
      position: row.position,
      name: row.name,
      quantity: row.quantity,
      totalMinor: row.total_minor,
    }));
}

export interface ExpenseReceiptItems {
  readonly expenseId: ExpenseId;
  // By position; empty for a fetched receipt that listed none.
  readonly items: readonly (FetchedItem & { readonly position: number })[];
}

// The items of the fetched receipts behind these expenses, one entry per expense that has one.
// An expense whose receipt is pending or failed, or that has none, gets no entry.
export function listFetchedReceiptItems(
  db: Db,
  expenseIds: readonly ExpenseId[],
): ExpenseReceiptItems[] {
  if (expenseIds.length === 0) return [];
  const rows = db
    .prepare<
      [string],
      {
        expense_id: string;
        position: number | null;
        name: string | null;
        quantity: string | null;
        total_minor: number | null;
      }
    >(
      `SELECT r.expense_id, i.position, i.name, i.quantity, i.total_minor
         FROM receipts r
         LEFT JOIN receipt_items i ON i.receipt_id = r.id
        WHERE r.fetch_state = 'fetched' AND r.expense_id IN (SELECT value FROM json_each(?))
        ORDER BY r.expense_id, i.position`,
    )
    .all(JSON.stringify(expenseIds));
  const byExpense = new Map<ExpenseId, (FetchedItem & { readonly position: number })[]>();
  for (const row of rows) {
    const expenseId = row.expense_id as ExpenseId;
    const items = byExpense.get(expenseId) ?? [];
    byExpense.set(expenseId, items);
    // The LEFT JOIN's one empty row for a receipt that listed no items.
    const { position, name, quantity, total_minor: totalMinor } = row;
    if (position === null || name === null || quantity === null || totalMinor === null) continue;
    items.push({ position, name, quantity, totalMinor });
  }
  return [...byExpense].map(([expenseId, items]) => ({ expenseId, items }));
}

export function countReceiptItems(db: Db, receiptId: ReceiptId): number {
  return (
    db
      .prepare<[string], number>('SELECT COUNT(*) FROM receipt_items WHERE receipt_id = ?')
      .pluck()
      .get(receiptId) ?? 0
  );
}
