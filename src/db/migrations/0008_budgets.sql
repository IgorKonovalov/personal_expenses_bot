-- ADR-0017: at most one budget per ledger. Its amounts are in `currency`, the ledger default at
-- the time the limit was last set; only expenses in that currency count toward it. Everything
-- else (allowances, remainders) is computed at read time.
CREATE TABLE ledger_budgets (
  ledger_id TEXT PRIMARY KEY REFERENCES ledgers(id),
  limit_minor INTEGER CHECK (limit_minor IS NULL OR limit_minor > 0),
  currency TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'optional')),
  period_start_day INTEGER NOT NULL DEFAULT 1 CHECK (period_start_day BETWEEN 1 AND 31),
  updated_at TEXT NOT NULL
);

-- A category's cap for the budget period of its ledger, in that ledger's budget currency.
CREATE TABLE category_caps (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id),
  cap_minor INTEGER NOT NULL CHECK (cap_minor > 0),
  updated_at TEXT NOT NULL
);
