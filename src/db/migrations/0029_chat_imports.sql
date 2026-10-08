-- ADR-0047: a group history import in progress, one per user. The payload holds the export's
-- messages from before the bot joined, chatter included: user data, never logged, deleted 24 hours
-- after the last tap by the sweep, and by /delete_account.
CREATE TABLE chat_imports (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  -- The bound group's Telegram chat id, as ledger_chats keeps it.
  chat_id TEXT NOT NULL,
  -- 6 base-36 characters, new on every upload; every import button carries it.
  nonce TEXT NOT NULL,
  -- JSON: the read messages, each message's decision and the name-prefix mappings.
  payload TEXT NOT NULL,
  -- The group notice, edited in place.
  notice_message_id INTEGER,
  -- UTC instant: 24 hours after the upload or the last tap.
  expires_at TEXT NOT NULL
);
CREATE INDEX chat_imports_expires ON chat_imports(expires_at);
