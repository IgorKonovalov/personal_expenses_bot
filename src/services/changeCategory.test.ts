import { beforeEach, describe, expect, it } from 'vitest';
import { archiveCategory, insertCategoriesOrIgnore, type CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import type { ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { changeCategory, openCategoryPicker } from './changeCategory.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, undoExpense, type RecordDeps } from './recordExpense.js';

const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps;
let alice: User;
let bob: User;
let message: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  message = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
  };
  const provision = (externalId: string) =>
    provisionUser(deps, {
      provider: 'telegram',
      externalId,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    }).user;
  alice = provision('1001');
  bob = provision('1002');
});

function record(
  user: User,
  text: string,
  at: Date = NOW,
): { id: ExpenseId; category: string | undefined } {
  const result = recordExpense(deps, {
    user,
    text,
    sourceKey: `tg:1:${++message}`,
    occurredAt: at,
    now: at,
  });
  if (result.kind !== 'recorded') throw new Error(`not recorded: ${result.kind}`);
  return { id: result.expense.id, category: result.expense.category?.name };
}

function categoryId(user: User, name: string): CategoryId {
  return db
    .prepare('SELECT id FROM categories WHERE ledger_id = ? AND name = ?')
    .pluck()
    .get(user.activeLedgerId, name) as CategoryId;
}

function storedCategory(expenseId: ExpenseId): unknown {
  return db.prepare('SELECT category_id FROM expenses WHERE id = ?').pluck().get(expenseId);
}

describe('changeCategory', () => {
  it('sets the category once; the same choice again writes nothing', () => {
    const { id } = record(alice, '450 кофе');
    const groceries = categoryId(alice, 'Продукты');

    expect(
      changeCategory(deps, { user: alice, expenseId: id, categoryId: groceries, now: NOW }),
    ).toMatchObject({
      kind: 'changed',
      expense: { category: { id: groceries, name: 'Продукты' } },
    });
    expect(storedCategory(id)).toBe(groceries);
    expect(
      changeCategory(deps, { user: alice, expenseId: id, categoryId: groceries, now: NOW }),
    ).toEqual({
      kind: 'unchanged',
    });
  });

  it('refuses a user who is not the creator, and writes nothing', () => {
    const { id } = record(alice, '450 кофе');
    const cafe = categoryId(alice, 'Кафе и рестораны');

    expect(
      changeCategory(deps, {
        user: bob,
        expenseId: id,
        categoryId: categoryId(alice, 'Продукты'),
        now: NOW,
      }),
    ).toEqual({ kind: 'forbidden' });
    expect(openCategoryPicker(deps, { user: bob, expenseId: id })).toEqual({ kind: 'forbidden' });
    expect(storedCategory(id)).toBe(cafe);
  });

  it("refuses another ledger's category and an archived one", () => {
    const { id } = record(alice, '450 кофе');
    const cafe = categoryId(alice, 'Кафе и рестораны');
    const groceries = categoryId(alice, 'Продукты');
    archiveCategory(db, groceries, NOW);

    expect(
      changeCategory(deps, {
        user: alice,
        expenseId: id,
        categoryId: categoryId(bob, 'Продукты'),
        now: NOW,
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      changeCategory(deps, { user: alice, expenseId: id, categoryId: groceries, now: NOW }),
    ).toEqual({
      kind: 'unavailable',
    });
    expect(storedCategory(id)).toBe(cafe);
  });

  it('refuses an undone expense', () => {
    const { id } = record(alice, '450 кофе');
    const cafe = categoryId(alice, 'Кафе и рестораны');
    undoExpense(deps, { user: alice, expenseId: id, now: NOW });

    expect(
      changeCategory(deps, {
        user: alice,
        expenseId: id,
        categoryId: categoryId(alice, 'Продукты'),
        now: NOW,
      }),
    ).toEqual({ kind: 'deleted' });
    expect(openCategoryPicker(deps, { user: alice, expenseId: id })).toEqual({ kind: 'deleted' });
    expect(storedCategory(id)).toBe(cafe);
  });

  it('lists only the active categories in the picker', () => {
    const { id } = record(alice, '450 кофе');
    archiveCategory(db, categoryId(alice, 'Продукты'), NOW);

    const picker = openCategoryPicker(deps, { user: alice, expenseId: id });

    expect(picker.kind === 'picker' && picker.categories.map((c) => c.name)).not.toContain(
      'Продукты',
    );
    expect(picker.kind === 'picker' && picker.categories.map((c) => c.name)).toContain(
      'Кафе и рестораны',
    );
  });
});

describe('learning from a change (ADR-0008)', () => {
  it('suggests the corrected category next time, skips an undone row, and stays per ledger', () => {
    const first = record(alice, '450 кофе');
    expect(first.category).toBe('Кафе и рестораны');
    changeCategory(deps, {
      user: alice,
      expenseId: first.id,
      categoryId: categoryId(alice, 'Продукты'),
      now: NOW,
    });

    const second = record(alice, '300 Кофе');
    expect(second.category).toBe('Продукты');
    undoExpense(deps, { user: alice, expenseId: second.id, now: NOW });

    expect(record(alice, '200 кофе').category).toBe('Продукты');
    expect(record(bob, '100 кофе').category).toBe('Кафе и рестораны');
  });

  it('learns from a change to an older expense, not only the newest one for the key', () => {
    const minute = (m: number) => new Date(NOW.getTime() + m * 60_000);
    const older = record(alice, '450 кофе', minute(0));
    expect(record(alice, '100 кофе', minute(1)).category).toBe('Кафе и рестораны');
    changeCategory(deps, {
      user: alice,
      expenseId: older.id,
      categoryId: categoryId(alice, 'Продукты'),
      now: minute(2),
    });

    expect(record(alice, '200 кофе', minute(3)).category).toBe('Продукты');
  });

  it('skips history whose category is archived and falls back to keyword rules', () => {
    const custom = 'Кофе на вынос';
    insertCategoriesOrIgnore(
      db,
      alice.activeLedgerId as LedgerId,
      [{ name: custom, nameKey: 'кофе на вынос', presetKey: null }],
      NOW,
    );
    const first = record(alice, '450 кофе');
    changeCategory(deps, {
      user: alice,
      expenseId: first.id,
      categoryId: categoryId(alice, custom),
      now: NOW,
    });
    expect(record(alice, '300 кофе').category).toBe(custom);

    archiveCategory(db, categoryId(alice, custom), NOW);

    expect(record(alice, '200 кофе').category).toBe('Кафе и рестораны');
  });
});
