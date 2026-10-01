import type { Db } from '../db/connection.js';
import {
  findActiveLedger,
  insertLedger,
  insertMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import {
  findUserByIdentity,
  insertIdentity,
  insertUser,
  setActiveLedger,
  type User,
  type UserId,
} from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { seedLedgerCategories } from './seedCategories.js';

export interface ProvisionInput {
  readonly provider: 'telegram';
  readonly externalId: string;
  // A new user's timezone. A user first seen in a group takes the group ledger's (ADR-0015).
  readonly defaultTimezone: string;
  readonly defaultCurrency: CurrencyCode;
  readonly now: Date;
}

export interface ServiceDeps {
  readonly db: Db;
  readonly newId: () => string;
}

// Finds the user behind an external identity, creating the user, the identity, a personal
// ledger with its preset categories, the owner membership and the active-ledger pointer on
// first contact. Idempotent.
export function provisionUser(
  { db, newId }: ServiceDeps,
  input: ProvisionInput,
): { user: User; ledger: Ledger; created: boolean } {
  return db.transaction(() => {
    const existing = findUserByIdentity(db, input.provider, input.externalId);
    if (existing !== undefined) {
      const ledger = findActiveLedger(db, existing.id);
      if (ledger === undefined) throw new Error(`user ${existing.id} has no active ledger`);
      return { user: existing, ledger, created: false };
    }

    const userId = newId() as UserId;
    const ledger: Ledger = {
      id: newId() as LedgerId,
      kind: 'personal',
      // The display name of a personal ledger comes from the messages module; this is a label.
      name: 'Personal',
      defaultCurrency: input.defaultCurrency,
      timezone: null,
    };
    insertUser(db, { id: userId, timezone: input.defaultTimezone, createdAt: input.now });
    insertIdentity(db, { provider: input.provider, externalId: input.externalId, userId });
    insertLedger(db, { ...ledger, ownerUserId: userId, createdAt: input.now });
    insertMember(db, { ledgerId: ledger.id, userId, role: 'owner' });
    seedLedgerCategories(db, ledger.id, input.now);
    setActiveLedger(db, userId, ledger.id);
    const user: User = { id: userId, timezone: input.defaultTimezone, activeLedgerId: ledger.id };
    return { user, ledger, created: true };
  })();
}
