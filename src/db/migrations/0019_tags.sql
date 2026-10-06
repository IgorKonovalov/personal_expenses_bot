-- An expense's tags in a plaintext ledger (ADR-0029): the normalized names space-joined in
-- first-written order, e.g. 'отпуск рим'. NULL for none, and always NULL in a sealed ledger,
-- whose tags live inside `sealed`.
ALTER TABLE expenses ADD COLUMN tags TEXT;
