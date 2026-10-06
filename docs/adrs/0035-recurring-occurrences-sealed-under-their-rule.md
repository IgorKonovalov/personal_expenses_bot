# ADR-0035: A sealed recurring occurrence opens under its rule's binding, not its own expense id

> **Status:** accepted (2026-10-06)
> **Date:** 2026-10-05
> **Related plan(s):** [Plan 0025](../plans/done/0025-recurring-expenses-and-reminders.md) Phase 6

## Context

ADR-0020 seals each row of an encrypted ledger to the ledger's public key, with the associated
data `<ledgerId>:<expenseId>` (`rowAad` in `src/services/ledgerKeys.ts`). The binding stops a file
holder from moving a ciphertext onto another row. Every open site (`openRow`, `foldedReceipt`,
`resealed`) rebuilds that string from the row it reads.

Plan 0025's `auto` rules record an expense on their due date with no one present, and a restart
locks every ledger, so the scheduler never holds a private key. Without the private key it cannot
read a template and seal it again. It can only copy bytes sealed while the ledger was unlocked.
Those bytes were sealed before the occurrence's expense id existed, so under ADR-0020's binding
the copy never opens.

## Decision

> A rule's template in a sealed ledger is sealed once, with the associated data
> `<ledgerId>:rule:<ruleId>`. An `auto` occurrence records an expense row whose `sealed` is a byte
> copy of the template and whose new nullable column `expenses.sealed_rule_id` names the rule.
> Every open site takes its associated data from one function of the row: `<ledgerId>:rule:<ruleId>`
> when `sealed_rule_id` is set, `<ledgerId>:<expenseId>` otherwise. Editing an occurrence reseals
> it under its own expense id and clears `sealed_rule_id`, so an edited occurrence becomes an
> ordinary sealed row. Enabling encryption on a ledger that already has expense rules seals their
> templates in the same transaction as its rows.

## Consequences

### Positive
- `auto` mode works in a sealed ledger with no passphrase on the server, as Plan 0025 promises.
- One function decides the binding, so no open site can drift from the sealing side.

### Negative
- Every unedited occurrence of a rule carries identical ciphertext. A file holder learns that those
  rows are equal. The rule link already says as much, so this leaks nothing new about content.
- Within one rule the ciphertext can be moved between occurrences without failing to open. The
  rows are identical anyway, and the public key already lets a file holder forge any row, so the
  binding never defended against forgery.
- A schema column and a branch in the key code exist for one feature. A test must pin both
  bindings, plus the clear-on-edit.

## Alternatives considered

### Alternative A: `auto` only while unlocked
In a sealed ledger an occurrence would fall back to an `ask` prompt and be sealed normally on the
owner's tap. It needs no crypto change, but a restart locks every ledger, so `auto` would become
`ask` in practice.

### Alternative B: pre-sealed future occurrences
The scheduler would reserve expense ids at rule creation and seal a batch of future occurrences
then. The batch runs out, has to be refilled while unlocked, and leaves dangling rows on edit or
delete.
