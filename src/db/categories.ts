import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';

// Integer ids, unlike the UUID tables, so `exp:setcat:<uuid>:<id>` fits callback_data (ADR-0007).
export type CategoryId = number & { readonly __brand: 'CategoryId' };

export interface Category {
  readonly id: CategoryId;
  readonly ledgerId: LedgerId;
  readonly name: string;
  readonly nameKey: string;
  readonly presetKey: string | null;
  readonly archivedAt: Date | null;
}

export interface NewCategory {
  readonly name: string;
  readonly nameKey: string;
  readonly presetKey: string | null;
}

interface CategoryRow {
  id: number;
  ledger_id: string;
  name: string;
  name_key: string;
  preset_key: string | null;
  archived_at: string | null;
}

const COLUMNS = 'id, ledger_id, name, name_key, preset_key, archived_at';

// Inserts each category unless the ledger already has its name key or preset key, so seeding a
// ledger twice adds nothing. Returns the number of rows inserted.
export function insertCategoriesOrIgnore(
  db: Db,
  ledgerId: LedgerId,
  categories: readonly NewCategory[],
  createdAt: Date,
): number {
  const insert = db.prepare<[string, string, string, string | null, string]>(
    `INSERT OR IGNORE INTO categories (ledger_id, name, name_key, preset_key, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  return db.transaction(() =>
    categories.reduce(
      (inserted, c) =>
        inserted +
        insert.run(ledgerId, c.name, c.nameKey, c.presetKey, createdAt.toISOString()).changes,
      0,
    ),
  )();
}

// The ledger's categories that the picker and suggestion may use, in creation order.
export function listActiveCategories(db: Db, ledgerId: LedgerId): Category[] {
  return db
    .prepare<[string], CategoryRow>(
      `SELECT ${COLUMNS} FROM categories
        WHERE ledger_id = ? AND archived_at IS NULL
        ORDER BY id`,
    )
    .all(ledgerId)
    .map(toCategory);
}

// Hides a category from the picker and suggestion; past expenses keep it (ADR-0007). Returns
// false when it was already archived.
export function archiveCategory(db: Db, id: CategoryId, archivedAt: Date): boolean {
  const { changes } = db
    .prepare<[string, number]>(
      'UPDATE categories SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
    )
    .run(archivedAt.toISOString(), id);
  return changes === 1;
}

// Ledgers with no category at all: created before categories existed.
export function listLedgersWithoutCategories(db: Db): LedgerId[] {
  return db
    .prepare<[], string>(
      `SELECT l.id FROM ledgers l
        WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.ledger_id = l.id)
        ORDER BY l.id`,
    )
    .pluck()
    .all() as LedgerId[];
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id as CategoryId,
    ledgerId: row.ledger_id as LedgerId,
    name: row.name,
    nameKey: row.name_key,
    presetKey: row.preset_key,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
  };
}
