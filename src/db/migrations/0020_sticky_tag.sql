-- A member's sticky tag in a plaintext ledger (ADR-0029): `/tag отпуск` adds it to every expense
-- that member records into the ledger until it is cleared. NULL for none. A sealed ledger keeps
-- it in process memory only, and this column stays NULL there.
ALTER TABLE ledger_members ADD COLUMN sticky_tag TEXT;
