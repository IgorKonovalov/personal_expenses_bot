import { insertCategoriesOrIgnore, listLedgersWithoutCategories } from '../db/categories.js';
import type { Db } from '../db/connection.js';
import type { LedgerId } from '../db/ledgers.js';
import { categoryNameKey } from '../domain/categories.js';
import { CATEGORY_PRESETS } from '../domain/categoryPresets.js';

// Gives a ledger one category per preset (ADR-0007). Idempotent: a preset the ledger already has,
// by name key or preset key, is skipped.
export function seedLedgerCategories(db: Db, ledgerId: LedgerId, now: Date): number {
  return insertCategoriesOrIgnore(
    db,
    ledgerId,
    CATEGORY_PRESETS.map((preset) => ({
      name: preset.name,
      nameKey: categoryNameKey(preset.name),
      presetKey: preset.key,
      essential: preset.essential,
    })),
    now,
  );
}

// Boot step: seeds every ledger that has no category yet, i.e. one created before categories
// existed. Returns the ledgers it seeded.
export function seedLedgersWithoutCategories(db: Db, now: Date): LedgerId[] {
  const ledgers = listLedgersWithoutCategories(db);
  for (const ledgerId of ledgers) seedLedgerCategories(db, ledgerId, now);
  return ledgers;
}
