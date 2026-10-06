-- Onboarding (ADR-0028): when the setup check was sent, and the tips switch. A user present
-- before this migration counts as onboarded, so only new users get the setup check.
-- UTC instant; NULL: never onboarded.
ALTER TABLE users ADD COLUMN onboarded_at TEXT;
-- 0 | 1
ALTER TABLE users ADD COLUMN tips_off INTEGER NOT NULL DEFAULT 0;
UPDATE users SET onboarded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- The contextual tips a user has been sent (ADR-0028): one row per user and tip, written before
-- the tip is sent. Keys only, never message content.
CREATE TABLE user_tips (
  user_id TEXT NOT NULL REFERENCES users(id),
  -- A registry key (src/domain/tips.ts).
  tip TEXT NOT NULL,
  -- UTC instant; the daily cap compares its local date.
  shown_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tip)
);
