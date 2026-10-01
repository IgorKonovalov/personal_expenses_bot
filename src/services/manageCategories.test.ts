import { beforeEach, describe, expect, it } from 'vitest';
import { insertCategoriesOrIgnore, type CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { routeText, setAnchor, type CategoryFlow as Flow } from './flowSessions.js';
import {
  answerCategoryFlow,
  hideCategory,
  setEssential,
  startAdd,
  startRename,
  MAX_ACTIVE_CATEGORIES,
} from './manageCategories.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';

const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps;
let user: User;
let ledgerId: LedgerId;
let input = 0;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
  };
  const provisioned = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  });
  user = provisioned.user;
  ledgerId = provisioned.ledger.id;
  setAnchor(deps, user, { chatId: 1001, messageId: 5, screen: { name: 'categories', ledgerId } });
});

function answer(flow: Flow, text: string) {
  return answerCategoryFlow(deps, { user, flow, text, inputKey: `tg:1001:${++input}`, now: NOW });
}

function idOf(name: string): CategoryId {
  return db
    .prepare('SELECT id FROM categories WHERE ledger_id = ? AND name = ?')
    .pluck()
    .get(ledgerId, name) as CategoryId;
}

function categoryRows(): unknown[] {
  return db.prepare('SELECT id, name, name_key, preset_key, archived_at FROM categories').all();
}

const addFlow = (): Flow => ({ kind: 'categoryAdd', ledgerId });

describe('adding a category', () => {
  it('creates it and completes the flow', () => {
    startAdd(deps, { user, ledgerId, now: NOW });

    expect(answer(addFlow(), ' Дача ')).toMatchObject({
      kind: 'added',
      category: { name: 'Дача', nameKey: 'дача', presetKey: null },
    });
    expect(routeText(deps, { user, inputKey: 'tg:1001:99', now: NOW }).kind).toBe('free');
    expect(routeText(deps, { user, inputKey: `tg:1001:${input}`, now: NOW }).kind).toBe(
      'redelivered',
    );
  });

  it.each([
    ['', 'empty'],
    ['я'.repeat(33), 'tooLong'],
    ['450 кофе', 'expenseShaped'],
    ['5 элемент', 'expenseShaped'],
    ['1-й', 'startsWithDigit'],
    ['кафе и рестораны', 'duplicate'],
  ])('refuses %j as %s and keeps the flow pending', (text, reason) => {
    startAdd(deps, { user, ledgerId, now: NOW });
    const before = categoryRows();

    expect(answer(addFlow(), text)).toEqual({ kind: 'invalid', reason });
    expect(categoryRows()).toEqual(before);
    expect(routeText(deps, { user, inputKey: 'tg:1001:99', now: NOW }).kind).toBe('flow');
  });

  it('restores an archived category with the same key instead of adding a row', () => {
    const transport = idOf('Транспорт');
    hideCategory(deps, { user, ledgerId, categoryId: transport, now: NOW });
    const count = db.prepare('SELECT COUNT(*) FROM categories').pluck().get();
    startAdd(deps, { user, ledgerId, now: NOW });

    expect(answer(addFlow(), 'ТРАНСПОРТ')).toMatchObject({
      kind: 'restored',
      category: { id: transport, name: 'Транспорт', archivedAt: null },
    });
    expect(db.prepare('SELECT COUNT(*) FROM categories').pluck().get()).toBe(count);
    expect(
      db.prepare('SELECT archived_at FROM categories WHERE id = ?').pluck().get(transport),
    ).toBeNull();
  });

  it(`refuses a new category past ${String(MAX_ACTIVE_CATEGORIES)} active ones`, () => {
    const active = db.prepare('SELECT COUNT(*) FROM categories').pluck().get() as number;
    insertCategoriesOrIgnore(
      db,
      ledgerId,
      Array.from({ length: MAX_ACTIVE_CATEGORIES - active }, (_, i) => ({
        name: `к${String(i)}`,
        nameKey: `к${String(i)}`,
        presetKey: null,
      })),
      NOW,
    );

    expect(startAdd(deps, { user, ledgerId, now: NOW })).toEqual({ kind: 'limit' });
  });
});

describe('renaming a category', () => {
  it('changes name and key, keeps id and preset key, and keyword rules still reach it', () => {
    const cafe = idOf('Кафе и рестораны');
    const started = startRename(deps, { user, ledgerId, categoryId: cafe, now: NOW });
    expect(started).toMatchObject({ kind: 'started', category: { name: 'Кафе и рестораны' } });

    expect(answer({ kind: 'categoryRename', ledgerId, categoryId: cafe }, 'Кофейни')).toMatchObject(
      { kind: 'renamed', category: { id: cafe, name: 'Кофейни' } },
    );
    expect(
      db.prepare('SELECT name, name_key, preset_key FROM categories WHERE id = ?').get(cafe),
    ).toEqual({ name: 'Кофейни', name_key: 'кофейни', preset_key: 'cafe' });

    const recorded = recordExpense(deps, {
      user,
      text: '450 кофе',
      sourceKey: 'tg:1001:500',
      occurredAt: NOW,
      now: NOW,
    });
    expect(recorded).toMatchObject({ expense: { category: { id: cafe, name: 'Кофейни' } } });
  });

  it("refuses another category's name", () => {
    const cafe = idOf('Кафе и рестораны');
    startRename(deps, { user, ledgerId, categoryId: cafe, now: NOW });

    expect(
      answer({ kind: 'categoryRename', ledgerId, categoryId: cafe }, 'продукты'),
    ).toMatchObject({ kind: 'invalid', reason: 'duplicate', current: { id: cafe } });
  });
});

describe('marking a category essential', () => {
  const essentialOf = (id: CategoryId) =>
    db.prepare('SELECT essential FROM categories WHERE id = ?').pluck().get(id);

  it('sets the value absolutely: the same value again is unchanged, not a toggle back', () => {
    const cafe = idOf('Кафе и рестораны');
    const set = (essential: boolean) =>
      setEssential(deps, { user, ledgerId, categoryId: cafe, essential });

    expect(set(true).kind).toBe('set');
    expect(set(true).kind).toBe('unchanged');
    expect(essentialOf(cafe)).toBe(1);
    expect(set(false).kind).toBe('set');
    expect(essentialOf(cafe)).toBe(0);
  });

  it('finds no archived category and writes nothing to it', () => {
    const gifts = idOf('Подарки');
    hideCategory(deps, { user, ledgerId, categoryId: gifts, now: NOW });

    expect(setEssential(deps, { user, ledgerId, categoryId: gifts, essential: true })).toEqual({
      kind: 'notFound',
    });
    expect(essentialOf(gifts)).toBe(0);
  });
});

describe('hiding a category', () => {
  it('archives it, and refuses the fallback', () => {
    expect(
      hideCategory(deps, { user, ledgerId, categoryId: idOf('Подарки'), now: NOW }),
    ).toMatchObject({ kind: 'archived', category: { name: 'Подарки' } });
    expect(hideCategory(deps, { user, ledgerId, categoryId: idOf('Другое'), now: NOW })).toEqual({
      kind: 'fallback',
    });
    expect(
      db.prepare('SELECT name FROM categories WHERE archived_at IS NOT NULL').pluck().all(),
    ).toEqual(['Подарки']);
  });
});
