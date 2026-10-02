-- Sealed ledgers (ADR-0020). A sealed ledger's public key is plaintext; its private key is
-- stored only wrapped, once per member passphrase and once under the recovery code.
CREATE TABLE ledger_keys (
  ledger_id TEXT PRIMARY KEY REFERENCES ledgers(id),
  -- Raw X25519, 32 bytes.
  public_key BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ledger_key_wraps (
  ledger_id TEXT NOT NULL REFERENCES ledger_keys(ledger_id),
  wrapper TEXT NOT NULL CHECK (wrapper IN ('member', 'recovery')),
  -- NULL for the recovery wrap.
  user_id TEXT REFERENCES users(id),
  -- 'argon2id' | 'hkdf-sha256'.
  kdf TEXT NOT NULL,
  -- JSON: the salt and the KDF's cost parameters.
  kdf_params TEXT NOT NULL,
  -- nonce || AES-256-GCM(ciphertext || tag).
  wrapped_private BLOB NOT NULL,
  CHECK ((wrapper = 'recovery') = (user_id IS NULL))
);

CREATE UNIQUE INDEX one_member_wrap ON ledger_key_wraps(ledger_id, user_id)
  WHERE wrapper = 'member';
CREATE UNIQUE INDEX one_recovery_wrap ON ledger_key_wraps(ledger_id)
  WHERE wrapper = 'recovery';

-- expenses, rebuilt: a sealed row holds `sealed` (amount, description and category, sealed to
-- the ledger's public key) with the plaintext columns NULL. SQLite can't relax NOT NULL in
-- place. The runner holds foreign_keys ON inside a transaction, where it can't be switched off,
-- so the rows referencing expenses are set aside, deleted, and put back after the swap.
CREATE TEMP TABLE receipt_items_keep AS SELECT * FROM receipt_items;
CREATE TEMP TABLE receipts_keep AS SELECT * FROM receipts;
DELETE FROM receipt_items;
DELETE FROM receipts;

CREATE TABLE expenses_sealed (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  amount_minor INTEGER CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  description TEXT,
  occurred_at TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  category_id INTEGER REFERENCES categories(id),
  description_key TEXT,
  category_set_at TEXT,
  updated_at TEXT,
  sealed BLOB,
  CHECK ((sealed IS NULL) = (amount_minor IS NOT NULL)),
  CHECK ((sealed IS NULL) = (description IS NOT NULL)),
  CHECK (sealed IS NULL OR (category_id IS NULL AND description_key IS NULL))
);

INSERT INTO expenses_sealed (id, ledger_id, created_by, amount_minor, currency, description,
                             occurred_at, occurred_on, source_key, created_at, deleted_at,
                             category_id, description_key, category_set_at, updated_at)
SELECT id, ledger_id, created_by, amount_minor, currency, description, occurred_at, occurred_on,
       source_key, created_at, deleted_at, category_id, description_key, category_set_at,
       updated_at
  FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_sealed RENAME TO expenses;

CREATE INDEX expenses_ledger_day ON expenses(ledger_id, occurred_on);
CREATE INDEX expenses_ledger_description ON expenses(ledger_id, description_key);

INSERT INTO receipts SELECT * FROM receipts_keep;
INSERT INTO receipt_items SELECT * FROM receipt_items_keep;
DROP TABLE receipts_keep;
DROP TABLE receipt_items_keep;
