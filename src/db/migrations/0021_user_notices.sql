-- One-time explanations the bot has shown a user (ADR-0037): one row per user and notice key,
-- inserted the first time the notice is shown. Keys only, never message content.
CREATE TABLE user_notices (
  user_id TEXT NOT NULL REFERENCES users(id),
  -- A NOTICES key (src/db/notices.ts).
  notice TEXT NOT NULL,
  -- UTC instant.
  seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, notice)
);
