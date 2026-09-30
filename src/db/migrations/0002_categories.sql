-- Categories belong to a ledger (ADR-0007). The integer id keeps callback_data short.
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  preset_key TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (ledger_id, name_key)
);

CREATE UNIQUE INDEX one_preset_per_ledger ON categories(ledger_id, preset_key)
  WHERE preset_key IS NOT NULL;

-- Existing expenses keep NULL in both columns (ADR-0007).
ALTER TABLE expenses ADD COLUMN category_id INTEGER REFERENCES categories(id);
ALTER TABLE expenses ADD COLUMN description_key TEXT;

CREATE INDEX expenses_ledger_description ON expenses(ledger_id, description_key);
