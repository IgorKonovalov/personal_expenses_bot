-- A user's correction for one normalized receipt item name (ADR-0039): it wins over the
-- built-in keyword rules. `product` is 'b:<catalog key>', 'u:<user_products.id>', or NULL for
-- "not a product". Never written for a sealed ledger. `set_at` is a UTC instant.
CREATE TABLE item_products (
  user_id TEXT NOT NULL REFERENCES users(id),
  name_key TEXT NOT NULL,
  product TEXT,
  set_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name_key)
);
