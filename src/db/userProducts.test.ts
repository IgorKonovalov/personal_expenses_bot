import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';
import { deleteUserProducts, insertUserProduct, listUserProducts } from './userProducts.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-06T10:00:00Z');
const A = 'user-a' as UserId;
const B = 'user-b' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: A, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertUser(db, { id: B, timezone: 'Europe/Belgrade', createdAt: NOW });
});

describe('user products', () => {
  it("lists one user's products oldest first, and none of another's", () => {
    const milk = insertUserProduct(db, {
      userId: A,
      name: 'Шоколадное молоко',
      unit: 'l',
      at: NOW,
    });
    const nuts = insertUserProduct(db, { userId: A, name: 'Орехи', unit: 'kg', at: NOW });
    insertUserProduct(db, { userId: B, name: 'Чипсы', unit: 'pcs', at: NOW });

    expect(listUserProducts(db, A)).toEqual([
      { id: milk, name: 'Шоколадное молоко', unit: 'l' },
      { id: nuts, name: 'Орехи', unit: 'kg' },
    ]);
  });

  it('rejects a unit other than l, kg or pcs', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO user_products (user_id, name, unit, created_at) VALUES (?, 'x', 'g', ?)",
        )
        .run(A, NOW.toISOString()),
    ).toThrow(/CHECK/);
  });

  it("deletes one user's products only", () => {
    insertUserProduct(db, { userId: A, name: 'Орехи', unit: 'kg', at: NOW });
    insertUserProduct(db, { userId: B, name: 'Чипсы', unit: 'pcs', at: NOW });

    deleteUserProducts(db, A);

    expect(listUserProducts(db, A)).toEqual([]);
    expect(listUserProducts(db, B)).toHaveLength(1);
  });
});
