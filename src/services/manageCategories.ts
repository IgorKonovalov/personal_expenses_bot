import {
  archiveCategory,
  findCategory,
  findCategoryByNameKey,
  insertCategory,
  listActiveCategories,
  renameCategory,
  restoreCategory,
  type Category,
  type CategoryId,
} from '../db/categories.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { parseCategoryName, type CategoryNameResult } from '../domain/categories.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import { cancelFlow, completeFlow, startFlow, type CategoryFlow } from './flowSessions.js';
import type { RecordDeps } from './recordExpense.js';

// The /categories use-cases (ADR-0007): add, rename and archive a ledger's categories. Every
// entry point re-checks that the user is still a member of the ledger it acts on.

// The picker pages 8 at a time, so this keeps it at 4 pages at most.
export const MAX_ACTIVE_CATEGORIES = 30;

export interface CategoriesView {
  readonly ledger: Ledger;
  readonly categories: readonly Category[];
}

interface LedgerInput {
  readonly user: User;
  readonly ledgerId: LedgerId;
}

// The /categories screen for the user's active ledger.
export function activeLedgerCategories({ db }: Pick<RecordDeps, 'db'>, user: User): CategoriesView {
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return { ledger, categories: listActiveCategories(db, ledger.id) };
}

// The screen for a ledger the anchor names; undefined once the user left it.
export function ledgerCategories(
  { db }: Pick<RecordDeps, 'db'>,
  input: LedgerInput,
): CategoriesView | undefined {
  const ledger = findLedgerForMember(db, input.ledgerId, input.user.id);
  return ledger === undefined
    ? undefined
    : { ledger, categories: listActiveCategories(db, ledger.id) };
}

// Categories the hide picker offers: every active one but the fallback.
export function archivableCategories(categories: readonly Category[]): Category[] {
  return categories.filter((c) => c.presetKey !== FALLBACK_PRESET);
}

export type StartResult =
  | { readonly kind: 'started'; readonly category?: Category }
  | { readonly kind: 'limit' }
  | { readonly kind: 'notFound' };

export function startAdd(
  deps: RecordDeps,
  input: LedgerInput & { readonly now: Date },
): StartResult {
  const view = ledgerCategories(deps, input);
  if (view === undefined) return { kind: 'notFound' };
  if (view.categories.length >= MAX_ACTIVE_CATEGORIES) return { kind: 'limit' };
  startFlow(deps, input.user, { kind: 'categoryAdd', ledgerId: input.ledgerId }, input.now);
  return { kind: 'started' };
}

export function startRename(
  deps: RecordDeps,
  input: LedgerInput & { readonly categoryId: CategoryId; readonly now: Date },
): StartResult {
  const category = ledgerCategories(deps, input)?.categories.find((c) => c.id === input.categoryId);
  if (category === undefined) return { kind: 'notFound' };
  startFlow(
    deps,
    input.user,
    { kind: 'categoryRename', ledgerId: input.ledgerId, categoryId: category.id },
    input.now,
  );
  return { kind: 'started', category };
}

export type HideResult =
  | { readonly kind: 'archived'; readonly category: Category }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'notFound' };

// Archives without asking: adding the name again restores it (ADR-0007).
export function hideCategory(
  deps: RecordDeps,
  input: LedgerInput & { readonly categoryId: CategoryId; readonly now: Date },
): HideResult {
  const category = ledgerCategories(deps, input)?.categories.find((c) => c.id === input.categoryId);
  if (category === undefined) return { kind: 'notFound' };
  if (category.presetKey === FALLBACK_PRESET) return { kind: 'fallback' };
  if (!archiveCategory(deps.db, category.id, input.now)) return { kind: 'notFound' };
  deps.logger.info({ categoryId: category.id, userId: input.user.id }, 'category archived');
  return { kind: 'archived', category };
}

export type NameRefusal =
  | Exclude<CategoryNameResult, { kind: 'ok' }>['kind']
  // Another category of the ledger, active or archived, has this name key.
  | 'duplicate'
  | 'limit';

export type AnswerResult =
  | { readonly kind: 'added'; readonly category: Category }
  | { readonly kind: 'restored'; readonly category: Category }
  | { readonly kind: 'renamed'; readonly category: Category }
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'invalid'; readonly reason: NameRefusal; readonly current?: Category }
  // The ledger or the category is out of reach now; the flow is cleared.
  | { readonly kind: 'gone' };

// Applies a typed answer to a category flow. A valid answer and the flow's completion commit
// together, keyed by `inputKey`, so a redelivered answer finds the flow already answered.
export function answerCategoryFlow(
  deps: RecordDeps,
  input: {
    readonly user: User;
    readonly flow: CategoryFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): AnswerResult {
  const { db, logger } = deps;
  const { user, flow } = input;
  return db.transaction((): AnswerResult => {
    const view = ledgerCategories(deps, { user, ledgerId: flow.ledgerId });
    const current =
      flow.kind === 'categoryRename' && view !== undefined
        ? findCategory(db, view.ledger.id, flow.categoryId)
        : undefined;
    if (view === undefined || (flow.kind === 'categoryRename' && current?.archivedAt !== null)) {
      cancelFlow(deps, user);
      return { kind: 'gone' };
    }
    const invalid = (reason: NameRefusal): AnswerResult =>
      current === undefined ? { kind: 'invalid', reason } : { kind: 'invalid', reason, current };

    const parsed = parseCategoryName(input.text, view.ledger.defaultCurrency);
    if (parsed.kind !== 'ok') return invalid(parsed.kind);
    const existing = findCategoryByNameKey(db, view.ledger.id, parsed.nameKey);

    if (current !== undefined) {
      if (existing !== undefined && existing.id !== current.id) return invalid('duplicate');
      renameCategory(db, current.id, parsed.name, parsed.nameKey);
      completeFlow(deps, user, input.inputKey);
      logger.info({ categoryId: current.id, userId: user.id }, 'category renamed');
      return {
        kind: 'renamed',
        category: { ...current, name: parsed.name, nameKey: parsed.nameKey },
      };
    }

    if (existing?.archivedAt === null) return invalid('duplicate');
    if (view.categories.length >= MAX_ACTIVE_CATEGORIES) return invalid('limit');
    completeFlow(deps, user, input.inputKey);
    if (existing !== undefined) {
      restoreCategory(db, existing.id);
      logger.info({ categoryId: existing.id, userId: user.id }, 'category restored');
      return { kind: 'restored', category: { ...existing, archivedAt: null } };
    }
    const id = insertCategory(
      db,
      view.ledger.id,
      { name: parsed.name, nameKey: parsed.nameKey, presetKey: null },
      input.now,
    );
    logger.info({ categoryId: id, userId: user.id }, 'category added');
    const added = findCategory(db, view.ledger.id, id);
    if (added === undefined) throw new Error('category vanished after insert');
    return { kind: 'added', category: added };
  })();
}
