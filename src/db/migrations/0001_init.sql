CREATE TABLE users (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  active_ledger_id TEXT REFERENCES ledgers(id),
  created_at TEXT NOT NULL
);

CREATE TABLE auth_identities (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE ledgers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
  name TEXT NOT NULL,
  default_currency TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_personal_ledger ON ledgers(owner_user_id) WHERE kind = 'personal';

CREATE TABLE ledger_members (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (ledger_id, user_id)
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX expenses_ledger_day ON expenses(ledger_id, occurred_on);
