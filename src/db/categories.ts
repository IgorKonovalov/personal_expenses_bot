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
  // Left out of a budget scoped to optional spending (ADR-0017).
  readonly essential: boolean;
}

export interface NewCategory {
  readonly name: string;
  readonly nameKey: string;
  readonly presetKey: string | null;
  // Optional (false) when omitted.
  readonly essential?: boolean;
}

interface CategoryRow {
  id: number;
  ledger_id: string;
  name: string;
  name_key: string;
  preset_key: string | null;
  archived_at: string | null;
  essential: 0 | 1;
}

const COLUMNS = 'id, ledger_id, name, name_key, preset_key, archived_at, essential';

// Inserts each category unless the ledger already has its name key or preset key, so seeding a
// ledger twice adds nothing. Returns the number of rows inserted.
export function insertCategoriesOrIgnore(
  db: Db,
  ledgerId: LedgerId,
  categories: readonly NewCategory[],
  createdAt: Date,
): number {
  const insert = db.prepare<[string, string, string, string | null, number, string]>(
    `INSERT OR IGNORE INTO categories (ledger_id, name, name_key, preset_key, essential, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction(() =>
    categories.reduce(
      (inserted, c) =>
        inserted +
        insert.run(
          ledgerId,
          c.name,
          c.nameKey,
          c.presetKey,
          c.essential === true ? 1 : 0,
          createdAt.toISOString(),
        ).changes,
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

// A category of this ledger, archived or not.
export function findCategory(db: Db, ledgerId: LedgerId, id: CategoryId): Category | undefined {
  const row = db
    .prepare<[string, number], CategoryRow>(
      `SELECT ${COLUMNS} FROM categories WHERE ledger_id = ? AND id = ?`,
    )
    .get(ledgerId, id);
  return row === undefined ? undefined : toCategory(row);
}

// The ledger's category with this name key, archived or not: name keys are unique per ledger.
export function findCategoryByNameKey(
  db: Db,
  ledgerId: LedgerId,
  nameKey: string,
): Category | undefined {
  const row = db
    .prepare<[string, string], CategoryRow>(
      `SELECT ${COLUMNS} FROM categories WHERE ledger_id = ? AND name_key = ?`,
    )
    .get(ledgerId, nameKey);
  return row === undefined ? undefined : toCategory(row);
}

export function insertCategory(
  db: Db,
  ledgerId: LedgerId,
  category: NewCategory,
  createdAt: Date,
): CategoryId {
  const { lastInsertRowid } = db
    .prepare<[string, string, string, string | null, string]>(
      `INSERT INTO categories (ledger_id, name, name_key, preset_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ledgerId, category.name, category.nameKey, category.presetKey, createdAt.toISOString());
  return Number(lastInsertRowid) as CategoryId;
}

// Clears archived_at. Returns false when the category wasn't archived.
export function restoreCategory(db: Db, id: CategoryId): boolean {
  const { changes } = db
    .prepare<[number]>(
      'UPDATE categories SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL',
    )
    .run(id);
  return changes === 1;
}

// Changes name and name_key; id and preset_key stay, so keyword rules still reach it.
export function renameCategory(db: Db, id: CategoryId, name: string, nameKey: string): void {
  db.prepare<[string, string, number]>(
    'UPDATE categories SET name = ?, name_key = ? WHERE id = ?',
  ).run(name, nameKey, id);
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

// Sets whether the category is essential, an absolute set so a repeated tap converges. Returns
// false when it already holds the value: nothing is written.
export function setCategoryEssential(db: Db, id: CategoryId, essential: boolean): boolean {
  const value = essential ? 1 : 0;
  const { changes } = db
    .prepare<[number, number, number]>(
      'UPDATE categories SET essential = ? WHERE id = ? AND essential <> ?',
    )
    .run(value, id, value);
  return changes === 1;
}

// The ids of the ledger's essential categories, archived ones included: past expenses keep them.
export function listEssentialCategoryIds(db: Db, ledgerId: LedgerId): ReadonlySet<CategoryId> {
  const ids = db
    .prepare<[string], number>(
      'SELECT id FROM categories WHERE ledger_id = ? AND essential = 1 ORDER BY id',
    )
    .pluck()
    .all(ledgerId);
  return new Set(ids as CategoryId[]);
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

// Deletes every category of the ledger, archived ones included. Run it after the ledger's
// expenses and caps are gone. Returns how many.
export function deleteLedgerCategories(db: Db, ledgerId: LedgerId): number {
  return db.prepare<[string]>('DELETE FROM categories WHERE ledger_id = ?').run(ledgerId).changes;
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id as CategoryId,
    ledgerId: row.ledger_id as LedgerId,
    name: row.name,
    nameKey: row.name_key,
    presetKey: row.preset_key,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
    essential: row.essential === 1,
  };
}
