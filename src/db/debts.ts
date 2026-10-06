import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { DebtKind } from '../domain/debts.js';
import type { LocalDate } from '../domain/time.js';
import type { Db } from './connection.js';
import type { ExpenseId } from './expenses.js';
import type { UserId } from './users.js';

// Personal debts (ADR-0030): a user's people and the operations against them. Balances are summed
// in the domain from the live operations, never in SQL.

export type DebtPersonId = number & { readonly __brand: 'DebtPersonId' };
export type DebtOpId = string & { readonly __brand: 'DebtOpId' };

export interface DebtPerson {
  readonly id: DebtPersonId;
  readonly userId: UserId;
  readonly name: string;
}

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

export type NewDebtOp = Omit<DebtOp, 'deletedAt'> & { readonly sourceKey: string };

interface PersonRow {
  id: number;
  user_id: string;
  name: string;
}

interface OpRow {
  id: string;
  user_id: string;
  person_id: number;
  kind: DebtKind;
  amount_minor: number;
  currency: string;
  occurred_on: string;
  expense_id: string | null;
  created_at: string;
  deleted_at: string | null;
}

const PERSON_COLUMNS = 'id, user_id, name';
const OP_COLUMNS = `id, user_id, person_id, kind, amount_minor, currency, occurred_on, expense_id,
  created_at, deleted_at`;

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

// The user's person whose lower-cased name is `nameKey`.
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
  return row === undefined ? undefined : toPerson(row);
}

// One of the user's people; undefined for another user's.
export function findDebtPerson(
  db: Db,
  userId: UserId,
  personId: DebtPersonId,
): DebtPerson | undefined {
  const row = db
    .prepare<[number, string], PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM debt_people WHERE id = ? AND user_id = ?`,
    )
    .get(personId, userId);
  return row === undefined ? undefined : toPerson(row);
}

// The user's people, oldest first.
export function listDebtPeople(db: Db, userId: UserId): DebtPerson[] {
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
): { readonly op: DebtOp; readonly created: boolean } {
  const { changes } = db
    .prepare<
      [string, string, number, string, number, string, string, string | null, string, string]
    >(
      `INSERT INTO debt_ops (id, user_id, person_id, kind, amount_minor, currency, occurred_on,
                             expense_id, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
    )
    .run(
      op.id,
      op.userId,
      op.personId,
      op.kind,
      op.amountMinor,
      op.currency,
      op.occurredOn,
      op.expenseId,
      op.sourceKey,
      op.createdAt.toISOString(),
    );
  const stored = findDebtOpBySourceKey(db, op.sourceKey);
  if (stored === undefined) throw new Error('debt operation vanished after insert');
  return { op: stored, created: changes === 1 };
}

export function findDebtOpBySourceKey(db: Db, sourceKey: string): DebtOp | undefined {
  const row = db
    .prepare<[string], OpRow>(`SELECT ${OP_COLUMNS} FROM debt_ops WHERE source_key = ?`)
    .get(sourceKey);
  return row === undefined ? undefined : toOp(row);
}

export function findDebtOp(db: Db, id: DebtOpId): DebtOp | undefined {
  const row = db
    .prepare<[string], OpRow>(`SELECT ${OP_COLUMNS} FROM debt_ops WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : toOp(row);
}

// The user's live operations, oldest first.
export function listDebtOps(db: Db, userId: UserId): DebtOp[] {
  return db
    .prepare<[string], OpRow>(
      `SELECT ${OP_COLUMNS} FROM debt_ops
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY occurred_on, created_at, rowid`,
    )
    .all(userId)
    .map(toOp);
}

function toPerson(row: PersonRow): DebtPerson {
  return { id: row.id as DebtPersonId, userId: row.user_id as UserId, name: row.name };
}

function toOp(row: OpRow): DebtOp {
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`debt operation ${row.id} has an unknown currency`);
  return {
    id: row.id as DebtOpId,
    userId: row.user_id as UserId,
    personId: row.person_id as DebtPersonId,
    kind: row.kind,
    amountMinor: row.amount_minor,
    currency,
    occurredOn: row.occurred_on as LocalDate,
    expenseId: row.expense_id as ExpenseId | null,
    createdAt: new Date(row.created_at),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
}
