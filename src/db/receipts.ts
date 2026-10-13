import type { ReceiptCountry } from '../domain/receipts/types.js';
import type { UtcWindow } from '../domain/time.js';
import type { CategoryId } from './categories.js';
import type { Db } from './connection.js';
import type { ExpenseId } from './expenses.js';
import type { LedgerId } from './ledgers.js';
import type { User, UserId } from './users.js';

export type ReceiptId = string & { readonly __brand: 'ReceiptId' };

export type FetchState = 'pending' | 'fetched' | 'failed';

// A fiscal receipt, enriched from the tax site, or a delivery order, born with its seller and
// items (ADR-0052). Only a fiscal receipt has a country, a fiscal id and a verification link.
interface ReceiptBase {
  readonly id: ReceiptId;
  readonly expenseId: ExpenseId;
  readonly merchantKey: string;
  readonly issuedAt: Date;
  readonly sellerName: string | null;
  readonly fetchState: FetchState;
  readonly attempts: number;
  readonly nextFetchAt: Date | null;
  readonly card: { readonly chatId: number; readonly messageId: number } | null;
  readonly createdAt: Date;
}

export interface FiscalReceipt extends ReceiptBase {
  readonly kind: 'fiscal';
  readonly country: ReceiptCountry;
  readonly fiscalId: string;
  readonly verifyUrl: string;
}

export interface OrderReceipt extends ReceiptBase {
  readonly kind: 'order';
  // `<source>:<order id>:<ledgerId>`: unique, so a re-sent order is a duplicate.
  readonly orderKey: string;
}

export type Receipt = FiscalReceipt | OrderReceipt;

export type NewReceipt = Pick<
  FiscalReceipt,
  'id' | 'expenseId' | 'country' | 'fiscalId' | 'merchantKey' | 'verifyUrl' | 'issuedAt'
> & { readonly createdAt: Date };

export type NewOrderReceipt = Pick<
  OrderReceipt,
  'id' | 'expenseId' | 'orderKey' | 'merchantKey' | 'issuedAt'
> & { readonly sellerName: string; readonly createdAt: Date };

interface ReceiptRow {
  id: string;
  expense_id: string;
  kind: string;
  country: string | null;
  fiscal_id: string | null;
  order_key: string | null;
  merchant_key: string;
  verify_url: string | null;
  issued_at: string;
  seller_name: string | null;
  fetch_state: string;
  attempts: number;
  next_fetch_at: string | null;
  card_chat_id: number | null;
  card_message_id: number | null;
  created_at: string;
}

const COLUMNS = `id, expense_id, kind, country, fiscal_id, order_key, merchant_key, verify_url,
  issued_at, seller_name, fetch_state, attempts, next_fetch_at, card_chat_id, card_message_id, created_at`;

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

// An order is born `fetched` with its seller: the fetch worker never sees it (ADR-0052).
export function insertOrderReceipt(db: Db, receipt: NewOrderReceipt): void {
  db.prepare<[string, string, string, string, string, string, string]>(
    `INSERT INTO receipts (id, expense_id, kind, order_key, merchant_key, issued_at, seller_name,
                           fetch_state, attempts, created_at)
     VALUES (?, ?, 'order', ?, ?, ?, ?, 'fetched', 0, ?)`,
  ).run(
    receipt.id,
    receipt.expenseId,
    receipt.orderKey,
    receipt.merchantKey,
    receipt.issuedAt.toISOString(),
    receipt.sellerName,
    receipt.createdAt.toISOString(),
  );
}

export function findReceiptByOrderKey(db: Db, orderKey: string): OrderReceipt | undefined {
  const row = db
    .prepare<[string], ReceiptRow>(`SELECT ${COLUMNS} FROM receipts WHERE order_key = ?`)
    .get(orderKey);
  if (row === undefined) return undefined;
  const receipt = toReceipt(row);
  if (receipt.kind !== 'order') throw new Error(`receipt ${row.id} has an order key`);
  return receipt;
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

// The pending receipt due earliest at `now`, if any: the worker's queue (ADR-0018). Only a
// fiscal receipt is ever pending.
export function findDueReceipt(db: Db, now: Date): FiscalReceipt | undefined {
  const row = db
    .prepare<[string], ReceiptRow>(
      `SELECT ${COLUMNS} FROM receipts
        WHERE fetch_state = 'pending' AND next_fetch_at <= ?
        ORDER BY next_fetch_at, rowid
        LIMIT 1`,
    )
    .get(now.toISOString());
  if (row === undefined) return undefined;
  const receipt = toReceipt(row);
  if (receipt.kind !== 'fiscal') throw new Error(`receipt ${row.id} is a pending order`);
  return receipt;
}

// Compare-and-set on `pending`: false when another fetch already settled the receipt, and then
// nothing is written.
export function markReceiptFetched(db: Db, id: ReceiptId, sellerName: string): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      `UPDATE receipts SET fetch_state = 'fetched', seller_name = ?, next_fetch_at = NULL
        WHERE id = ? AND fetch_state = 'pending'`,
    )
    .run(sellerName, id);
  return changes === 1;
}

// A failed attempt: `attempts` moves from the value the caller read, and the receipt is either
// rescheduled or, with `nextFetchAt` null, `failed`. False when the row moved on meanwhile.
export function recordReceiptFailure(
  db: Db,
  id: ReceiptId,
  update: { readonly fromAttempts: number; readonly nextFetchAt: Date | null },
): boolean {
  const { changes } = db
    .prepare<[string | null, string | null, string, number]>(
      `UPDATE receipts
          SET attempts = attempts + 1,
              next_fetch_at = ?,
              fetch_state = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END
        WHERE id = ? AND fetch_state = 'pending' AND attempts = ?`,
    )
    .run(
      update.nextFetchAt?.toISOString() ?? null,
      update.nextFetchAt?.toISOString() ?? null,
      id,
      update.fromAttempts,
    );
  return changes === 1;
}

// [Повторить]: a `failed` receipt becomes `pending` again, with no attempts, due at `now`.
// Compare-and-set on `failed`, so a second tap changes nothing.
export function resetFailedReceipt(db: Db, id: ReceiptId, now: Date): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      `UPDATE receipts SET fetch_state = 'pending', attempts = 0, next_fetch_at = ?
        WHERE id = ? AND fetch_state = 'failed'`,
    )
    .run(now.toISOString(), id);
  return changes === 1;
}

// The message the receipt's card was last sent as, for the worker's edit.
export function setReceiptCard(
  db: Db,
  id: ReceiptId,
  card: { readonly chatId: number; readonly messageId: number },
): void {
  db.prepare<[number, number, string]>(
    'UPDATE receipts SET card_chat_id = ?, card_message_id = ? WHERE id = ?',
  ).run(card.chatId, card.messageId, id);
}

// What the worker may still change on a receipt's expense (ADR-0018): the description while it
// is the placeholder and the expense was never edited, the category while it is the one chosen
// at recording (category_set_at = created_at).
export interface ReceiptExpenseState {
  readonly descriptionUntouched: boolean;
  readonly categoryUntouched: boolean;
  readonly categoryPresetKey: string | null;
}

export function findReceiptExpenseState(
  db: Db,
  expenseId: ExpenseId,
  placeholder: string,
): ReceiptExpenseState | undefined {
  const row = db
    .prepare<
      [string, string],
      { description_untouched: 0 | 1; category_untouched: 0 | 1; preset_key: string | null }
    >(
      `SELECT (e.description = ? AND e.updated_at IS NULL) AS description_untouched,
              (e.category_set_at IS NOT NULL AND e.category_set_at = e.created_at)
                AS category_untouched,
              c.preset_key
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.id = ?`,
    )
    .get(placeholder, expenseId);
  return row === undefined
    ? undefined
    : {
        descriptionUntouched: row.description_untouched === 1,
        categoryUntouched: row.category_untouched === 1,
        categoryPresetKey: row.preset_key,
      };
}

// Each guarded like findReceiptExpenseState, so a user edit landing first wins. Neither stamps
// updated_at or category_set_at: the change isn't the user's.
export function fillReceiptDescription(
  db: Db,
  expenseId: ExpenseId,
  text: {
    readonly placeholder: string;
    readonly description: string;
    readonly descriptionKey: string;
  },
): boolean {
  const { changes } = db
    .prepare<[string, string, string, string]>(
      `UPDATE expenses SET description = ?, description_key = ?
        WHERE id = ? AND description = ? AND updated_at IS NULL`,
    )
    .run(text.description, text.descriptionKey, expenseId, text.placeholder);
  return changes === 1;
}

export function fillReceiptCategory(db: Db, expenseId: ExpenseId, categoryId: CategoryId): boolean {
  const { changes } = db
    .prepare<[number, string]>(
      `UPDATE expenses SET category_id = ?
        WHERE id = ? AND category_set_at IS NOT NULL AND category_set_at = created_at`,
    )
    .run(categoryId, expenseId);
  return changes === 1;
}

// The user who recorded the receipt's expense.
export function findReceiptAuthor(db: Db, expenseId: ExpenseId): User | undefined {
  const row = db
    .prepare<[string], { id: string; timezone: string; active_ledger_id: string | null }>(
      `SELECT u.id, u.timezone, u.active_ledger_id
         FROM expenses e JOIN users u ON u.id = e.created_by
        WHERE e.id = ?`,
    )
    .get(expenseId);
  return row === undefined
    ? undefined
    : {
        id: row.id as UserId,
        timezone: row.timezone,
        activeLedgerId: row.active_ledger_id as LedgerId | null,
      };
}

// How many receipts the user recorded within the window, in any ledger, deleted expenses
// included: the daily receipt cap's count (ADR-0024).
export function countReceiptsCreatedBy(db: Db, userId: UserId, window: UtcWindow): number {
  return (
    db
      .prepare<[string, string, string], number>(
        `SELECT COUNT(*) FROM receipts r JOIN expenses e ON e.id = r.expense_id
          WHERE e.created_by = ? AND r.created_at >= ? AND r.created_at < ?`,
      )
      .pluck()
      .get(userId, window.start.toISOString(), window.end.toISOString()) ?? 0
  );
}

// Every receipt behind the ledger's expenses, deleted expenses included.
export function listLedgerReceipts(db: Db, ledgerId: LedgerId): Receipt[] {
  return db
    .prepare<[string], ReceiptRow>(
      `SELECT ${COLUMNS} FROM receipts
        WHERE expense_id IN (SELECT id FROM expenses WHERE ledger_id = ?)`,
    )
    .all(ledgerId)
    .map(toReceipt);
}

// Deletes the ledger's receipts and their items, once sealing has folded them into the sealed
// rows (ADR-0020). Run it in that transaction. Returns the number of receipts deleted.
export function deleteLedgerReceipts(db: Db, ledgerId: LedgerId): number {
  const mine = `SELECT id FROM receipts
    WHERE expense_id IN (SELECT id FROM expenses WHERE ledger_id = ?)`;
  db.prepare<[string]>(`DELETE FROM receipt_items WHERE receipt_id IN (${mine})`).run(ledgerId);
  return db.prepare<[string]>(`DELETE FROM receipts WHERE id IN (${mine})`).run(ledgerId).changes;
}

function toReceipt(row: ReceiptRow): Receipt {
  if (
    row.fetch_state !== 'pending' &&
    row.fetch_state !== 'fetched' &&
    row.fetch_state !== 'failed'
  ) {
    throw new Error(`receipt ${row.id} has an unknown fetch state`);
  }
  const base: ReceiptBase = {
    id: row.id as ReceiptId,
    expenseId: row.expense_id as ExpenseId,
    merchantKey: row.merchant_key,
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
  if (row.kind === 'order') {
    if (row.order_key === null) throw new Error(`order receipt ${row.id} has no order key`);
    return { ...base, kind: 'order', orderKey: row.order_key };
  }
  if (row.kind !== 'fiscal') throw new Error(`receipt ${row.id} has an unknown kind`);
  if (row.country !== 'RS' && row.country !== 'ME') {
    throw new Error(`receipt ${row.id} has an unknown country`);
  }
  if (row.fiscal_id === null || row.verify_url === null) {
    throw new Error(`fiscal receipt ${row.id} lacks its fiscal fields`);
  }
  return {
    ...base,
    kind: 'fiscal',
    country: row.country,
    fiscalId: row.fiscal_id,
    verifyUrl: row.verify_url,
  };
}
