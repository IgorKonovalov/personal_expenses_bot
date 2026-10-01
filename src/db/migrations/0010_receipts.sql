-- A fiscal receipt behind an expense (ADR-0018). The row is also the enrichment queue: a
-- `pending` receipt is fetched when next_fetch_at is due.
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  country TEXT NOT NULL CHECK (country IN ('RS', 'ME')),
  fiscal_id TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  verify_url TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  seller_name TEXT,
  fetch_state TEXT NOT NULL CHECK (fetch_state IN ('pending', 'fetched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_fetch_at TEXT,
  card_chat_id INTEGER,
  card_message_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX receipts_due ON receipts(fetch_state, next_fetch_at);
CREATE INDEX receipts_merchant ON receipts(merchant_key);

CREATE TABLE receipt_items (
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  -- A decimal string such as '0.535': a quantity, not money.
  quantity TEXT NOT NULL,
  -- In the expense's currency.
  total_minor INTEGER NOT NULL,
  PRIMARY KEY (receipt_id, position)
);
