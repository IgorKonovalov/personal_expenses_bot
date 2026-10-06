-- The summary pushes (ADR-0031 scheduler): the closed period's report, sent to the personal
-- ledger's owner at 09:00 local on the day after the period ends. The monthly push is on for
-- every user, existing and new; the weekly one is off until they turn it on.
-- 0 | 1
ALTER TABLE users ADD COLUMN monthly_push INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN weekly_push INTEGER NOT NULL DEFAULT 0;

-- One row per (ledger, kind, period key) pushed: inserting it claims the push before anything is
-- sent, so it happens at most once. `period` is the monthly push, keyed `2026-09` for a calendar
-- month or by its first day (`2026-09-15`) for a budget period; `week` is keyed by its Monday.
-- `empty`: the period had no expenses, and nothing was sent.
CREATE TABLE summary_pushes (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  kind TEXT NOT NULL CHECK (kind IN ('period', 'week')),
  period_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'empty')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, kind, period_key)
);
