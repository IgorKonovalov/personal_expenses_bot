-- Personal debts (ADR-0030): a per-user list of people, and signed operations against them. A
-- person's balance in a currency is a sum over their live operations, never stored. In a sealed
-- personal ledger (ADR-0020) a person's name and an operation's kind, amount and currency are in
-- `sealed`, and their plaintext columns are NULL.
CREATE TABLE debt_people (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT,
  -- The name lower-cased: a typed name equal to it, ignoring case, reuses the person.
  name_key TEXT,
  sealed BLOB,
  created_at TEXT NOT NULL,
  CHECK ((sealed IS NULL) = (name IS NOT NULL)),
  CHECK ((name IS NULL) = (name_key IS NULL))
);

CREATE INDEX debt_people_user ON debt_people(user_id);
CREATE UNIQUE INDEX debt_people_name ON debt_people(user_id, name_key) WHERE name_key IS NOT NULL;

CREATE TABLE debt_ops (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  person_id INTEGER NOT NULL REFERENCES debt_people(id),
  kind TEXT CHECK (kind IN ('lend', 'borrow', 'repaid_to_me', 'i_repaid')),
  amount_minor INTEGER CHECK (amount_minor > 0),
  currency TEXT,
  sealed BLOB,
  occurred_on TEXT NOT NULL,
  -- The split expense a lend was recorded with. Deleting the expense keeps the debt.
  expense_id TEXT REFERENCES expenses(id) ON DELETE SET NULL,
  -- The update that recorded it: a redelivery finds the row instead of adding another.
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((sealed IS NULL) = (kind IS NOT NULL)),
  CHECK ((sealed IS NULL) = (amount_minor IS NOT NULL)),
  CHECK ((sealed IS NULL) = (currency IS NOT NULL))
);

CREATE INDEX debt_ops_person ON debt_ops(user_id, person_id) WHERE deleted_at IS NULL;
