-- Group settle-up (ADR-0030). A member shares an expense when they had joined by its local date:
-- `joined_at` is when the membership began, backfilled with the ledger's creation for the
-- members who existed before it was tracked.
ALTER TABLE ledger_members ADD COLUMN joined_at TEXT;

UPDATE ledger_members
   SET joined_at = (SELECT l.created_at FROM ledgers l WHERE l.id = ledger_members.ledger_id);

-- A transfer between two members squares part of a balance, in its own currency.
CREATE TABLE ledger_transfers (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  from_user TEXT NOT NULL REFERENCES users(id),
  to_user TEXT NOT NULL REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  -- The tap that recorded it: a redelivery finds the row instead of adding another.
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (from_user <> to_user)
);

CREATE INDEX ledger_transfers_ledger ON ledger_transfers(ledger_id) WHERE deleted_at IS NULL;
