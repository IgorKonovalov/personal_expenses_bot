-- Recurring expenses and reminders (Plan 0025, ADR-0031). A rule holds a template and a
-- schedule; `next_due_on` is a local date, and the scheduler computes its 09:00 instant in the
-- ledger's timezone on every tick. An expense rule's template is plaintext, or `sealed` in a
-- sealed ledger (ADR-0035) with the plaintext columns NULL; the currency stays plaintext, as on
-- an expense row. A reminder has no ledger and no template, only its text.
CREATE TABLE recurring_rules (
  id TEXT PRIMARY KEY,
  ledger_id TEXT REFERENCES ledgers(id),
  -- The author: whose expense each occurrence records, and who is told.
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'ask')),
  amount_minor INTEGER CHECK (amount_minor > 0),
  currency TEXT,
  description TEXT,
  category_id INTEGER REFERENCES categories(id),
  sealed BLOB,
  reminder_text TEXT,
  schedule TEXT NOT NULL CHECK (schedule IN ('monthly', 'weekly', 'yearly')),
  -- 1-31 for monthly and yearly; a short month falls on its last day, and the day stays.
  day INTEGER CHECK (day BETWEEN 1 AND 31),
  -- 1-7, ISO (Monday 1), for weekly.
  weekday INTEGER CHECK (weekday BETWEEN 1 AND 7),
  -- 1-12 for yearly.
  month INTEGER CHECK (month BETWEEN 1 AND 12),
  next_due_on TEXT NOT NULL,
  -- What made the rule, for a rule made from an expense: `exp:<expenseId>:<m|w|y>`. A second tap
  -- of the same schedule finds the live rule instead of making another.
  source_key TEXT,
  paused_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'reminder') = (ledger_id IS NULL)),
  CHECK ((kind = 'reminder') = (reminder_text IS NOT NULL)),
  CHECK ((kind = 'reminder') = (currency IS NULL)),
  CHECK (kind = 'reminder' OR (sealed IS NULL) = (amount_minor IS NOT NULL)),
  CHECK (kind = 'reminder' OR (sealed IS NULL) = (description IS NOT NULL)),
  CHECK (sealed IS NULL OR category_id IS NULL),
  CHECK (schedule <> 'monthly' OR (day IS NOT NULL AND weekday IS NULL AND month IS NULL)),
  CHECK (schedule <> 'weekly' OR (weekday IS NOT NULL AND day IS NULL AND month IS NULL)),
  CHECK (schedule <> 'yearly' OR (day IS NOT NULL AND month IS NOT NULL AND weekday IS NULL))
);

CREATE INDEX recurring_due ON recurring_rules(next_due_on)
  WHERE deleted_at IS NULL AND paused_at IS NULL;
CREATE INDEX recurring_user ON recurring_rules(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX recurring_source ON recurring_rules(source_key)
  WHERE source_key IS NOT NULL AND deleted_at IS NULL;

-- One row per (rule, local due date) that happened: inserting it claims the occurrence, in the
-- transaction that records the expense and advances the rule, so it happens once (ADR-0031).
CREATE TABLE recurring_occurrences (
  rule_id TEXT NOT NULL REFERENCES recurring_rules(id),
  due_on TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'asked', 'reminded', 'skipped')),
  expense_id TEXT REFERENCES expenses(id),
  PRIMARY KEY (rule_id, due_on)
);
