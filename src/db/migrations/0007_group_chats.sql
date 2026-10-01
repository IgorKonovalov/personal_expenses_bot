-- ADR-0015: the zone a shared ledger's dates and periods are computed in. NULL for a personal
-- ledger, whose owner's timezone applies. SQLite can't add the CHECK through ALTER TABLE, so
-- insertLedger refuses a shared ledger without one.
ALTER TABLE ledgers ADD COLUMN timezone TEXT;

-- The member's Telegram first name, as last seen in a group. User data: never logged.
ALTER TABLE ledger_members ADD COLUMN display_name TEXT;

-- ADR-0014: a group chat bound to one shared ledger. The chat id is an external identity and
-- never a ledger key. An inactive row keeps the binding for a re-add.
CREATE TABLE ledger_chats (
  provider TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL UNIQUE REFERENCES ledgers(id),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  bound_by TEXT NOT NULL REFERENCES users(id),
  bound_at TEXT NOT NULL,
  PRIMARY KEY (provider, chat_id)
);
