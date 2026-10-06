-- Admission (ADR-0024): who may use the bot in private is a fact on the user, set by redeeming
-- an invite code. All three columns hold UTC instants; NULL means "not".
ALTER TABLE users ADD COLUMN admitted_at TEXT;
ALTER TABLE users ADD COLUMN blocked_at TEXT;
-- A tombstone: the account was deleted, the row stays for the group expenses it authored.
ALTER TABLE users ADD COLUMN deleted_at TEXT;

CREATE TABLE invite_codes (
  -- 11 characters: 8 random bytes, base64url.
  code TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE invite_redemptions (
  code TEXT NOT NULL REFERENCES invite_codes(code),
  user_id TEXT NOT NULL REFERENCES users(id),
  redeemed_at TEXT NOT NULL,
  PRIMARY KEY (code, user_id)
);
