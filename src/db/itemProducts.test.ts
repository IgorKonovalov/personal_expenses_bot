import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { deleteUserItemProducts, listItemProducts, setItemProduct } from './itemProducts.js';
import { runMigrations } from './migrate.js';
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

const rows = () => db.prepare('SELECT user_id, name_key, product, set_at FROM item_products').all();

describe('item products', () => {
  it('keeps one row per user and name: a repeated answer upserts it', () => {
    setItemProduct(db, A, 'kesa', null, NOW);
    setItemProduct(db, A, 'kesa', null, NOW);

    expect(rows()).toEqual([
      { user_id: A, name_key: 'kesa', product: null, set_at: NOW.toISOString() },
    ]);
  });

  it('replaces an earlier answer and keeps users apart', () => {
    const later = new Date('2026-10-07T10:00:00Z');
    setItemProduct(db, A, 'mleko imlek', 'b:milk', NOW);
    setItemProduct(db, B, 'mleko imlek', 'b:milk', NOW);
    setItemProduct(db, A, 'mleko imlek', null, later);

    expect(listItemProducts(db, A)).toEqual(new Map([['mleko imlek', null]]));
    expect(listItemProducts(db, B)).toEqual(new Map([['mleko imlek', 'b:milk']]));
  });

  it("deletes one user's rows only", () => {
    setItemProduct(db, A, 'kesa', null, NOW);
    setItemProduct(db, B, 'kesa', null, NOW);

    deleteUserItemProducts(db, A);

    expect(listItemProducts(db, A).size).toBe(0);
    expect(listItemProducts(db, B).size).toBe(1);
  });
});
