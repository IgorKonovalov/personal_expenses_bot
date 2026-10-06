import type { FetchedItem } from '../domain/receipts/types.js';
import type { Db } from './connection.js';
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

export function countReceiptItems(db: Db, receiptId: ReceiptId): number {
  return (
    db
      .prepare<[string], number>('SELECT COUNT(*) FROM receipt_items WHERE receipt_id = ?')
      .pluck()
      .get(receiptId) ?? 0
  );
}
