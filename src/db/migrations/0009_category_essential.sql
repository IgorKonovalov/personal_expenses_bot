-- ADR-0017: an essential category's spend is left out of a budget scoped to optional spending.
-- The presets marked essential in categoryPresets.ts are marked here by preset_key; categories
-- users created stay optional.
ALTER TABLE categories ADD COLUMN essential INTEGER NOT NULL DEFAULT 0 CHECK (essential IN (0, 1));

UPDATE categories SET essential = 1
 WHERE preset_key IN ('groceries', 'housing', 'health', 'telecom', 'transport');
