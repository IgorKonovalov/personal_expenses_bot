-- A recurring occurrence in a sealed ledger (ADR-0035): its `sealed` is a byte copy of its rule's
-- sealed template, which opens under the rule's binding `<ledgerId>:rule:<ruleId>`, and this
-- column names that rule. NULL for every other row, whose `sealed` opens under its own id;
-- resealing a row (an edit) clears it.
ALTER TABLE expenses ADD COLUMN sealed_rule_id TEXT REFERENCES recurring_rules(id)
  CHECK (sealed_rule_id IS NULL OR sealed IS NOT NULL);
