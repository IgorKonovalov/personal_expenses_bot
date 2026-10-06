import type { Unit } from '../domain/products/amount.js';
import type { Db } from './connection.js';
import type { UserId } from './users.js';

// The user's own products (ADR-0039), next to the built-in catalog.

export type UserProductId = number & { readonly __brand: 'UserProductId' };

export interface UserProduct {
  readonly id: UserProductId;
  readonly name: string;
  readonly unit: Unit;
}

export function insertUserProduct(
  db: Db,
  input: { readonly userId: UserId; readonly name: string; readonly unit: Unit; readonly at: Date },
): UserProductId {
  const result = db
    .prepare<[string, string, string, string]>(
      'INSERT INTO user_products (user_id, name, unit, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(input.userId, input.name, input.unit, input.at.toISOString());
  return Number(result.lastInsertRowid) as UserProductId;
}

// Oldest first.
export function listUserProducts(db: Db, userId: UserId): UserProduct[] {
  return db
    .prepare<[string], { id: number; name: string; unit: Unit }>(
      'SELECT id, name, unit FROM user_products WHERE user_id = ? ORDER BY id',
    )
    .all(userId)
    .map((row) => ({ id: row.id as UserProductId, name: row.name, unit: row.unit }));
}

export function deleteUserProducts(db: Db, userId: UserId): void {
  db.prepare<[string]>('DELETE FROM user_products WHERE user_id = ?').run(userId);
}
