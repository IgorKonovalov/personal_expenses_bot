-- Donations in Telegram Stars (ADR-0027). `stars` is a whole count, not money. The charge id is
-- Telegram's, and its uniqueness makes a redelivered payment record once. A row outlives the
-- donor's other data because a refund needs it.
CREATE TABLE donations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars > 0),
  telegram_payment_charge_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  refunded_at TEXT
);

CREATE INDEX donations_user ON donations(user_id, created_at);
