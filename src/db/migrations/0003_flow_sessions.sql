-- One row per user (ADR-0009): the screen anchor of ADR-0011 and at most one pending text flow.
CREATE TABLE flow_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  anchor_chat_id INTEGER,
  anchor_message_id INTEGER,
  screen TEXT,
  screen_ctx TEXT,
  kind TEXT,
  payload TEXT,
  -- Kept after expiry, so a late answer gets the flowExpired reply.
  expires_at TEXT,
  -- `tg:<chat>:<msg>` of the last consumed answer; a redelivery of it is ignored.
  last_input_key TEXT
);
