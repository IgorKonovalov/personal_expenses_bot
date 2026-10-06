-- A product the user made for receipt item names the catalog lacks (ADR-0039). It is assigned
-- to a name through item_products as 'u:<id>'. `unit` is what its price is quoted per: a litre,
-- a kilogram or a piece. `created_at` is a UTC instant.
CREATE TABLE user_products (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('l', 'kg', 'pcs')),
  created_at TEXT NOT NULL
);

CREATE INDEX user_products_user ON user_products (user_id);
