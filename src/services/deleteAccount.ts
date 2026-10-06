import { deleteLedgerBudget, deleteLedgerCaps } from '../db/budgets.js';
import { deleteLedgerCategories } from '../db/categories.js';
import type { Db } from '../db/connection.js';
import { deleteUserDebts } from '../db/debts.js';
import { deleteLedgerExpenses } from '../db/expenses.js';
import { deleteFlowSession } from '../db/flowSessions.js';
import { clearMemberDisplayNames, deleteLedger, findPersonalLedger } from '../db/ledgers.js';
import { deleteLedgerReceipts } from '../db/receipts.js';
import { deleteUserOccurrences, deleteUserRules } from '../db/recurring.js';
import { findAdmissionByIdentity, isUserDeleted, tombstoneUser, type UserId } from '../db/users.js';
import type { Logger } from '../logger.js';
import type { LedgerKeyring } from './ledgerKeys.js';

// /delete_account (ADR-0024). One transaction hard-deletes the personal ledger with every
// expense, receipt and its items, budget, cap, category, sealed key and membership, every
// recurring rule and reminder the user made in any ledger with its occurrences, every debt
// person and operation (ADR-0030), then the user's
// flow session and identity, and leaves the users row as a tombstone: `deleted_at` set,
// admission and the active ledger cleared, and the display name forgotten in every group. The
// user's expenses in group ledgers stay, so the group's totals don't change; they show under
// a deleted member. The Telegram id then matches no one and needs an invite like anyone else.

export interface DeleteAccountDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly keys: LedgerKeyring;
}

export type DeleteAccountResult = 'deleted' | 'alreadyDeleted';

// Whether the user behind an expense's `created_by` deleted their account.
export function isAccountDeleted({ db }: Pick<DeleteAccountDeps, 'db'>, userId: UserId): boolean {
  return isUserDeleted(db, userId);
}

export function deleteAccount(
  { db, logger, keys }: DeleteAccountDeps,
  input: { readonly telegramId: number; readonly now: Date },
): DeleteAccountResult {
  const deleted = db.transaction(() => {
    // No identity: deleted already (a double tap), or never provisioned.
    const admission = findAdmissionByIdentity(db, 'telegram', String(input.telegramId));
    if (admission === undefined) return undefined;
    const { userId } = admission;
    const personal = findPersonalLedger(db, userId);
    const personalId = personal?.id ?? null;
    deleteUserOccurrences(db, userId, personalId);
    if (personal !== undefined) {
      deleteLedgerReceipts(db, personal.id);
      deleteLedgerExpenses(db, personal.id);
    }
    deleteUserRules(db, userId, personalId);
    deleteUserDebts(db, userId);
    if (personal !== undefined) {
      deleteLedgerCaps(db, personal.id);
      deleteLedgerBudget(db, personal.id);
      deleteLedgerCategories(db, personal.id);
      deleteLedger(db, personal.id);
    }
    deleteFlowSession(db, userId);
    clearMemberDisplayNames(db, userId);
    tombstoneUser(db, userId, input.now);
    return { userId, personalId: personal?.id };
  })();
  if (deleted === undefined) return 'alreadyDeleted';
  // An unlocked key of a ledger that no longer exists.
  if (deleted.personalId !== undefined) keys.lock(deleted.personalId);
  logger.info({ userId: deleted.userId }, 'account deleted');
  return 'deleted';
}
