import type { Db } from './connection.js';
import type { UserId } from './users.js';

// A user's corrections of receipt item names (ADR-0039), keyed by user and normalized name. A
// product is stored as its ref (`b:<key>` or `u:<id>`); null is "not a product".

// Sets the name's product, replacing any earlier answer: a repeated answer rewrites the same row.
export function setItemProduct(
  db: Db,
  userId: UserId,
  nameKey: string,
  product: string | null,
  at: Date,
): void {
  db.prepare<[string, string, string | null, string]>(
    `INSERT INTO item_products (user_id, name_key, product, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, name_key) DO UPDATE SET product = excluded.product, set_at = excluded.set_at`,
  ).run(userId, nameKey, product, at.toISOString());
}

// Every name the user answered, with its product or null.
export function listItemProducts(db: Db, userId: UserId): Map<string, string | null> {
  const rows = db
    .prepare<[string], { name_key: string; product: string | null }>(
      'SELECT name_key, product FROM item_products WHERE user_id = ?',
    )
    .all(userId);
  return new Map(rows.map((row) => [row.name_key, row.product]));
}

export function deleteUserItemProducts(db: Db, userId: UserId): void {
  db.prepare<[string]>('DELETE FROM item_products WHERE user_id = ?').run(userId);
}
