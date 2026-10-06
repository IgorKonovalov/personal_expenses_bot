import type { Db } from '../db/connection.js';
import {
  listPlaintextDebtOps,
  listPlaintextDebtPeople,
  sealDebtOpInPlace,
  sealDebtPersonInPlace,
  type DebtOpId,
  type DebtPersonId,
} from '../db/debts.js';
import {
  listLedgerPlaintextExpenses,
  rekeyContentSourceKeys,
  sealExpenseInPlace,
  type ExpenseId,
} from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { listReceiptItems } from '../db/receiptItems.js';
import { listLedgerPlaintextRules, sealRuleTemplateInPlace, type RuleId } from '../db/recurring.js';
import { deleteLedgerReceipts, listLedgerReceipts } from '../db/receipts.js';
import type { UserId } from '../db/users.js';
import type {
  SealedDebtOpV1,
  SealedDebtPersonV1,
  SealedPayloadV1,
  SealedReceipt,
} from '../domain/sealing.js';

// Sealing a ledger that has history (ADR-0020): every plaintext row, deleted ones included, is
// sealed in place, and a receipt's seller, link and items fold into its row's payload before
// the receipt rows are deleted. Source keys derived from content (a bank SMS fingerprint, a
// receipt's fiscal id) become `sealed:<expenseId>`, since a guess could be checked against them.
// The ledger's recurring rule templates, and its owner's debts, are sealed with the rows.
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

// Seals every plaintext expense rule template of the ledger, deleted rules included, with
// `seal`, and clears its amount, description and category (ADR-0035). Run it in the same
// transaction as sealLedgerRows. Returns the number of rules sealed.
export function sealLedgerRules(
  db: Db,
  ledgerId: LedgerId,
  seal: (
    ruleId: RuleId,
    template: Pick<SealedPayloadV1, 'amountMinor' | 'description' | 'categoryId'>,
  ) => Buffer,
): number {
  const rules = listLedgerPlaintextRules(db, ledgerId);
  for (const rule of rules) {
    if (rule.template === null) throw new Error(`rule ${rule.id} has no template`);
    const { amountMinor, description, categoryId } = rule.template;
    const sealed = seal(rule.id, { amountMinor, description, categoryId });
    if (!sealRuleTemplateInPlace(db, rule.id, sealed)) {
      throw new Error(`rule ${rule.id} was sealed concurrently`);
    }
  }
  return rules.length;
}

// Seals every plaintext debt person's name, and every plaintext debt operation's kind, amount and
// currency, deleted operations included, of the personal ledger's owner (ADR-0030), and clears
// those columns. Run it in the same transaction as sealLedgerRows. Returns the number of people
// and operations sealed.
export function sealUserDebts(
  db: Db,
  userId: UserId,
  seal: {
    readonly person: (personId: DebtPersonId, payload: SealedDebtPersonV1) => Buffer;
    readonly op: (opId: DebtOpId, payload: SealedDebtOpV1) => Buffer;
  },
): { readonly people: number; readonly ops: number } {
  const people = listPlaintextDebtPeople(db, userId);
  for (const person of people) {
    if (
      !sealDebtPersonInPlace(db, person.id, seal.person(person.id, { v: 1, name: person.name }))
    ) {
      throw new Error(`debt person ${String(person.id)} was sealed concurrently`);
    }
  }
  const ops = listPlaintextDebtOps(db, userId);
  for (const op of ops) {
    const payload: SealedDebtOpV1 = {
      v: 1,
      kind: op.kind,
      amountMinor: op.amountMinor,
      currency: op.currency,
    };
    if (!sealDebtOpInPlace(db, op.id, seal.op(op.id, payload))) {
      throw new Error(`debt operation ${op.id} was sealed concurrently`);
    }
  }
  return { people: people.length, ops: ops.length };
}

// Outside any transaction: the WAL's old frames go into the file and the WAL is emptied, then
// VACUUM rebuilds the file without the freed pages. secure_delete (set at connection open) has
// already zeroed what the updates freed.
export function scrubFreedPages(db: Db): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}
