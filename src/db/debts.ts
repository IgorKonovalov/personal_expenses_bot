import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { DebtKind } from '../domain/debts.js';
import type { LocalDate } from '../domain/time.js';
import type { Db } from './connection.js';
import type { ExpenseId } from './expenses.js';
import type { UserId } from './users.js';

// Personal debts (ADR-0030): a user's people and the operations against them. Balances are summed
// in the domain from the live operations, never in SQL. In a sealed personal ledger (ADR-0020) a
// row's name, or kind, amount and currency, are in `sealed` and its plaintext columns are NULL:
// those rows come back as Sealed*, for the service to open.

export type DebtPersonId = number & { readonly __brand: 'DebtPersonId' };
export type DebtOpId = string & { readonly __brand: 'DebtOpId' };

export interface DebtPerson {
  readonly id: DebtPersonId;
  readonly userId: UserId;
  readonly name: string;
}

export interface SealedDebtPerson {
  readonly id: DebtPersonId;
  readonly userId: UserId;
  readonly sealed: Buffer;
}

export type StoredDebtPerson = DebtPerson | SealedDebtPerson;

export interface DebtOp {
  readonly id: DebtOpId;
  readonly userId: UserId;
  readonly personId: DebtPersonId;
  readonly kind: DebtKind;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
  readonly expenseId: ExpenseId | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface SealedDebtOp extends Omit<DebtOp, 'kind' | 'amountMinor' | 'currency'> {
  readonly sealed: Buffer;
}

export type StoredDebtOp = DebtOp | SealedDebtOp;

export type NewDebtOp = (Omit<DebtOp, 'deletedAt'> | Omit<SealedDebtOp, 'deletedAt'>) & {
  readonly sourceKey: string;
};

interface PersonRow {
  id: number;
  user_id: string;
  name: string | null;
  sealed: Buffer | null;
}

interface OpRow {
  id: string;
  user_id: string;
  person_id: number;
  kind: DebtKind | null;
  amount_minor: number | null;
  currency: string | null;
  sealed: Buffer | null;
  occurred_on: string;
  expense_id: string | null;
  created_at: string;
  deleted_at: string | null;
}

const PERSON_COLUMNS = 'id, user_id, name, sealed';
const OP_COLUMNS = `id, user_id, person_id, kind, amount_minor, currency, sealed, occurred_on,
  expense_id, created_at, deleted_at`;

// A person whose name is sealed under a binding naming the row's id: the row is inserted with an
// empty blob, then `seal` is given the id it got.
export function insertSealedDebtPerson(
  db: Db,
  person: {
    readonly userId: UserId;
    readonly createdAt: Date;
    readonly seal: (id: DebtPersonId) => Buffer;
  },
): SealedDebtPerson {
  return db.transaction((): SealedDebtPerson => {
    const { lastInsertRowid } = db
      .prepare<[string, Buffer, string]>(
        'INSERT INTO debt_people (user_id, sealed, created_at) VALUES (?, ?, ?)',
      )
      .run(person.userId, Buffer.alloc(0), person.createdAt.toISOString());
    const id = Number(lastInsertRowid) as DebtPersonId;
    const sealed = person.seal(id);
    db.prepare<[Buffer, number]>('UPDATE debt_people SET sealed = ? WHERE id = ?').run(sealed, id);
    return { id, userId: person.userId, sealed };
  })();
}

export function insertDebtPerson(
  db: Db,
  person: {
    readonly userId: UserId;
    readonly name: string;
    readonly nameKey: string;
    readonly createdAt: Date;
  },
): DebtPerson {
  const { lastInsertRowid } = db
    .prepare<[string, string, string, string]>(
      'INSERT INTO debt_people (user_id, name, name_key, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(person.userId, person.name, person.nameKey, person.createdAt.toISOString());
  return { id: Number(lastInsertRowid) as DebtPersonId, userId: person.userId, name: person.name };
}

// The user's plaintext person whose lower-cased name is `nameKey`. A sealed person has no key:
// matching one is the service's, against the opened names.
export function findDebtPersonByKey(
  db: Db,
  userId: UserId,
  nameKey: string,
): DebtPerson | undefined {
  const row = db
    .prepare<[string, string], PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM debt_people WHERE user_id = ? AND name_key = ?`,
    )
    .get(userId, nameKey);
  const person = row === undefined ? undefined : toPerson(row);
  return person === undefined || 'sealed' in person ? undefined : person;
}

// One of the user's people; undefined for another user's.
export function findDebtPerson(
  db: Db,
  userId: UserId,
  personId: DebtPersonId,
): StoredDebtPerson | undefined {
  const row = db
    .prepare<[number, string], PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM debt_people WHERE id = ? AND user_id = ?`,
    )
    .get(personId, userId);
  return row === undefined ? undefined : toPerson(row);
}

// The user's people, oldest first.
export function listDebtPeople(db: Db, userId: UserId): StoredDebtPerson[] {
  return db
    .prepare<[string], PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM debt_people WHERE user_id = ? ORDER BY id`,
    )
    .all(userId)
    .map(toPerson);
}

// Inserts unless the source key exists; either way returns the stored operation.
export function insertDebtOpOrGetExisting(
  db: Db,
  op: NewDebtOp,
): { readonly op: StoredDebtOp; readonly created: boolean } {
  const sealed = 'sealed' in op ? op.sealed : null;
  const plain = 'sealed' in op ? undefined : op;
  const { changes } = db
    .prepare<
      [
        string,
        string,
        number,
        string | null,
        number | null,
        string | null,
        Buffer | null,
        string,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO debt_ops (id, user_id, person_id, kind, amount_minor, currency, sealed,
                             occurred_on, expense_id, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
    )
    .run(
      op.id,
      op.userId,
      op.personId,
      plain?.kind ?? null,
      plain?.amountMinor ?? null,
      plain?.currency ?? null,
      sealed,
      op.occurredOn,
      op.expenseId,
      op.sourceKey,
      op.createdAt.toISOString(),
    );
  const stored = findDebtOpBySourceKey(db, op.sourceKey);
  if (stored === undefined) throw new Error('debt operation vanished after insert');
  return { op: stored, created: changes === 1 };
}

export function findDebtOpBySourceKey(db: Db, sourceKey: string): StoredDebtOp | undefined {
  const row = db
    .prepare<[string], OpRow>(`SELECT ${OP_COLUMNS} FROM debt_ops WHERE source_key = ?`)
    .get(sourceKey);
  return row === undefined ? undefined : toOp(row);
}

export function findDebtOp(db: Db, id: DebtOpId): StoredDebtOp | undefined {
  const row = db
    .prepare<[string], OpRow>(`SELECT ${OP_COLUMNS} FROM debt_ops WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : toOp(row);
}

// The user's live operations, oldest first.
export function listDebtOps(db: Db, userId: UserId): StoredDebtOp[] {
  return db
    .prepare<[string], OpRow>(
      `SELECT ${OP_COLUMNS} FROM debt_ops
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY occurred_on, created_at, rowid`,
    )
    .all(userId)
    .map(toOp);
}

// A person's last `limit` live operations, newest first.
export function listPersonOps(
  db: Db,
  userId: UserId,
  personId: DebtPersonId,
  limit: number,
): StoredDebtOp[] {
  return db
    .prepare<[string, number, number], OpRow>(
      `SELECT ${OP_COLUMNS} FROM debt_ops
        WHERE user_id = ? AND person_id = ? AND deleted_at IS NULL
        ORDER BY occurred_on DESC, created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(userId, personId, limit)
    .map(toOp);
}

// Returns false when the operation was deleted already.
export function softDeleteDebtOp(db: Db, id: DebtOpId, deletedAt: Date): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      'UPDATE debt_ops SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(deletedAt.toISOString(), id);
  return changes === 1;
}

function toPerson(row: PersonRow): StoredDebtPerson {
  const ids = { id: row.id as DebtPersonId, userId: row.user_id as UserId };
  if (row.name !== null) return { ...ids, name: row.name };
  if (row.sealed === null) throw new Error(`debt person ${String(row.id)} has no name`);
  return { ...ids, sealed: row.sealed };
}

function toOp(row: OpRow): StoredDebtOp {
  const common = {
    id: row.id as DebtOpId,
    userId: row.user_id as UserId,
    personId: row.person_id as DebtPersonId,
    occurredOn: row.occurred_on as LocalDate,
    expenseId: row.expense_id as ExpenseId | null,
    createdAt: new Date(row.created_at),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
  if (row.sealed !== null) return { ...common, sealed: row.sealed };
  const currency = row.currency === null ? undefined : toCurrencyCode(row.currency);
  if (currency === undefined || row.kind === null || row.amount_minor === null) {
    throw new Error(`debt operation ${row.id} is incomplete`);
  }
  return { ...common, kind: row.kind, amountMinor: row.amount_minor, currency };
}
