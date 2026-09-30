-- When the expense's amount, description or date was last edited from its card. NULL for an
-- expense never edited.
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
