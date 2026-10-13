-- receipts, rebuilt (ADR-0052): a row is a fiscal receipt or a delivery order. A fiscal row
-- carries country, fiscal_id and verify_url and no order_key; an order row carries order_key
-- and none of the fiscal columns, and is born fetched with its seller. SQLite can't relax NOT
-- NULL in place, and the runner holds foreign_keys ON inside a transaction, so the items
-- referencing receipts are set aside, deleted, and put back after the swap.
CREATE TEMP TABLE receipt_items_keep AS SELECT * FROM receipt_items;
DELETE FROM receipt_items;

CREATE TABLE receipts_kinds (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  kind TEXT NOT NULL DEFAULT 'fiscal' CHECK (kind IN ('fiscal', 'order')),
  country TEXT CHECK (country IN ('RS', 'ME')),
  fiscal_id TEXT,
  -- `<source>:<order id>:<ledgerId>`: one order per ledger.
  order_key TEXT,
  merchant_key TEXT NOT NULL,
  verify_url TEXT,
  issued_at TEXT NOT NULL,
  seller_name TEXT,
  fetch_state TEXT NOT NULL CHECK (fetch_state IN ('pending', 'fetched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_fetch_at TEXT,
  card_chat_id INTEGER,
  card_message_id INTEGER,
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'fiscal' AND country IS NOT NULL AND fiscal_id IS NOT NULL
      AND verify_url IS NOT NULL AND order_key IS NULL)
    OR
    (kind = 'order' AND country IS NULL AND fiscal_id IS NULL AND verify_url IS NULL
      AND order_key IS NOT NULL AND seller_name IS NOT NULL AND fetch_state = 'fetched')
  )
);

INSERT INTO receipts_kinds (id, expense_id, kind, country, fiscal_id, merchant_key, verify_url,
                            issued_at, seller_name, fetch_state, attempts, next_fetch_at,
                            card_chat_id, card_message_id, created_at)
SELECT id, expense_id, 'fiscal', country, fiscal_id, merchant_key, verify_url, issued_at,
       seller_name, fetch_state, attempts, next_fetch_at, card_chat_id, card_message_id,
       created_at
  FROM receipts;

DROP TABLE receipts;
ALTER TABLE receipts_kinds RENAME TO receipts;

CREATE INDEX receipts_due ON receipts(fetch_state, next_fetch_at);
CREATE INDEX receipts_merchant ON receipts(merchant_key);
CREATE UNIQUE INDEX receipts_order_key ON receipts(order_key) WHERE order_key IS NOT NULL;

INSERT INTO receipt_items SELECT * FROM receipt_items_keep;
DROP TABLE receipt_items_keep;
