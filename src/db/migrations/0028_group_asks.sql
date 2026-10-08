-- ADR-0046: the bot's pending question to an amount-last group message («Чайник 3200»), one per
-- message. The text is user data: never logged, deleted on an answer, at expiry and by
-- /delete_account. The sender is the Telegram id the question is for, not a user, since a
-- sender who never recorded has none.
CREATE TABLE group_asks (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  sender_telegram_id TEXT NOT NULL,
  -- The message as sent.
  text TEXT NOT NULL,
  -- The message's date, UTC instant.
  sent_at TEXT NOT NULL,
  ask_message_id INTEGER NOT NULL,
  -- UTC instant; the question expires 15 minutes after it.
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX group_asks_created ON group_asks(created_at);
