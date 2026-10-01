import type { FetchedItem } from '../domain/receipts/types.js';
import type { Db } from './connection.js';
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

export function countReceiptItems(db: Db, receiptId: ReceiptId): number {
  return (
    db
      .prepare<[string], number>('SELECT COUNT(*) FROM receipt_items WHERE receipt_id = ?')
      .pluck()
      .get(receiptId) ?? 0
  );
}
