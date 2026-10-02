import type { Db } from '../db/connection.js';
import {
  listLedgerPlaintextExpenses,
  rekeyContentSourceKeys,
  sealExpenseInPlace,
  type ExpenseId,
} from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { listReceiptItems } from '../db/receiptItems.js';
import { deleteLedgerReceipts, listLedgerReceipts } from '../db/receipts.js';
import type { SealedPayloadV1, SealedReceipt } from '../domain/sealing.js';

// Sealing a ledger that has history (ADR-0020): every plaintext row, deleted ones included, is
// sealed in place, and a receipt's seller, link and items fold into its row's payload before
// the receipt rows are deleted. Source keys derived from content (a bank SMS fingerprint, a
// receipt's fiscal id) become `sealed:<expenseId>`, since a guess could be checked against them.
// Afterwards the freed pages are scrubbed from the file and WAL.

// True while any receipt of the ledger is still being fetched: its items would arrive after
// the row is sealed, so enabling waits.
export function hasPendingReceipts(db: Db, ledgerId: LedgerId): boolean {
  return listLedgerReceipts(db, ledgerId).some((r) => r.fetchState === 'pending');
}

// Seals every plaintext row of the ledger with `seal` and re-keys its content-derived source
// keys. Run it inside the transaction that stores
// the ledger's key, so a failure leaves every row plaintext and no key. Returns the number of
// rows sealed.
export function sealLedgerRows(
  db: Db,
  ledgerId: LedgerId,
  seal: (expenseId: ExpenseId, payload: SealedPayloadV1) => Buffer,
): number {
  const receipts = new Map(
    listLedgerReceipts(db, ledgerId).map((r) => {
      if (r.fetchState === 'pending') throw new Error(`receipt ${r.id} is still pending`);
      const receipt: SealedReceipt = {
        sellerName: r.sellerName,
        verifyUrl: r.verifyUrl,
        items: listReceiptItems(db, r.id),
      };
      return [r.expenseId, receipt] as const;
    }),
  );
  const rows = listLedgerPlaintextExpenses(db, ledgerId);
  for (const row of rows) {
    const receipt = receipts.get(row.id);
    const payload: SealedPayloadV1 = {
      v: 1,
      amountMinor: row.amountMinor,
      description: row.description,
      categoryId: row.category?.id ?? null,
      ...(receipt === undefined ? {} : { receipt }),
    };
    if (!sealExpenseInPlace(db, row.id, seal(row.id, payload))) {
      throw new Error(`expense ${row.id} was sealed concurrently`);
    }
  }
  deleteLedgerReceipts(db, ledgerId);
  rekeyContentSourceKeys(db, ledgerId);
  return rows.length;
}

// Outside any transaction: the WAL's old frames go into the file and the WAL is emptied, then
// VACUUM rebuilds the file without the freed pages. secure_delete (set at connection open) has
// already zeroed what the updates freed.
export function scrubFreedPages(db: Db): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}
