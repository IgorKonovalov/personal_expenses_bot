-- When the expense's category was last set: at recording, or by a change from its card. The
-- ADR-0008 history step orders by it, so a correction makes that expense the most recent match.
-- NULL for rows recorded before this column; readers fall back to created_at.
ALTER TABLE expenses ADD COLUMN category_set_at TEXT;
