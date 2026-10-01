import type { ReceiptCountry } from '../domain/receipts/types.js';
import type { CategoryId } from './categories.js';
import type { Db } from './connection.js';
import type { ExpenseId } from './expenses.js';
import type { LedgerId } from './ledgers.js';

export type ReceiptId = string & { readonly __brand: 'ReceiptId' };

export type FetchState = 'pending' | 'fetched' | 'failed';

export interface Receipt {
  readonly id: ReceiptId;
  readonly expenseId: ExpenseId;
  readonly country: ReceiptCountry;
  readonly fiscalId: string;
  readonly merchantKey: string;
  readonly verifyUrl: string;
  readonly issuedAt: Date;
  readonly sellerName: string | null;
  readonly fetchState: FetchState;
  readonly attempts: number;
  readonly nextFetchAt: Date | null;
  readonly card: { readonly chatId: number; readonly messageId: number } | null;
  readonly createdAt: Date;
}

export type NewReceipt = Pick<
  Receipt,
  'id' | 'expenseId' | 'country' | 'fiscalId' | 'merchantKey' | 'verifyUrl' | 'issuedAt'
> & { readonly createdAt: Date };

interface ReceiptRow {
  id: string;
  expense_id: string;
  country: string;
  fiscal_id: string;
  merchant_key: string;
  verify_url: string;
  issued_at: string;
  seller_name: string | null;
  fetch_state: string;
  attempts: number;
  next_fetch_at: string | null;
  card_chat_id: number | null;
  card_message_id: number | null;
  created_at: string;
}

const COLUMNS = `id, expense_id, country, fiscal_id, merchant_key, verify_url, issued_at,
  seller_name, fetch_state, attempts, next_fetch_at, card_chat_id, card_message_id, created_at`;

// A new receipt is `pending` and due at once.
export function insertReceipt(db: Db, receipt: NewReceipt): void {
  db.prepare<[string, string, string, string, string, string, string, string, string]>(
    `INSERT INTO receipts (id, expense_id, country, fiscal_id, merchant_key, verify_url, issued_at,
                           fetch_state, attempts, next_fetch_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    receipt.id,
    receipt.expenseId,
    receipt.country,
    receipt.fiscalId,
    receipt.merchantKey,
    receipt.verifyUrl,
    receipt.issuedAt.toISOString(),
    receipt.createdAt.toISOString(),
    receipt.createdAt.toISOString(),
  );
}

export function findReceiptByExpense(db: Db, expenseId: ExpenseId): Receipt | undefined {
  const row = db
    .prepare<[string], ReceiptRow>(`SELECT ${COLUMNS} FROM receipts WHERE expense_id = ?`)
    .get(expenseId);
  return row === undefined ? undefined : toReceipt(row);
}

export function findReceiptById(db: Db, id: ReceiptId): Receipt | undefined {
  const row = db
    .prepare<[string], ReceiptRow>(`SELECT ${COLUMNS} FROM receipts WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : toReceipt(row);
}

// The category of the ledger's live receipt expense from the same shop whose category was set
// most recently, skipping archived categories: the history step of ADR-0008, keyed by merchant.
export function findMerchantCategory(
  db: Db,
  ledgerId: LedgerId,
  merchantKey: string,
): CategoryId | undefined {
  const id = db
    .prepare<[string, string], number>(
      `SELECT e.category_id
         FROM receipts r
         JOIN expenses e ON e.id = r.expense_id
         JOIN categories c ON c.id = e.category_id
        WHERE e.ledger_id = ? AND r.merchant_key = ?
          AND e.deleted_at IS NULL AND c.archived_at IS NULL
        ORDER BY COALESCE(e.category_set_at, e.created_at) DESC, e.rowid DESC
        LIMIT 1`,
    )
    .pluck()
    .get(ledgerId, merchantKey);
  return id === undefined ? undefined : (id as CategoryId);
}

function toReceipt(row: ReceiptRow): Receipt {
  if (row.country !== 'RS' && row.country !== 'ME') {
    throw new Error(`receipt ${row.id} has an unknown country`);
  }
  if (
    row.fetch_state !== 'pending' &&
    row.fetch_state !== 'fetched' &&
    row.fetch_state !== 'failed'
  ) {
    throw new Error(`receipt ${row.id} has an unknown fetch state`);
  }
  return {
    id: row.id as ReceiptId,
    expenseId: row.expense_id as ExpenseId,
    country: row.country,
    fiscalId: row.fiscal_id,
    merchantKey: row.merchant_key,
    verifyUrl: row.verify_url,
    issuedAt: new Date(row.issued_at),
    sellerName: row.seller_name,
    fetchState: row.fetch_state,
    attempts: row.attempts,
    nextFetchAt: row.next_fetch_at === null ? null : new Date(row.next_fetch_at),
    card:
      row.card_chat_id === null || row.card_message_id === null
        ? null
        : { chatId: row.card_chat_id, messageId: row.card_message_id },
    createdAt: new Date(row.created_at),
  };
}
