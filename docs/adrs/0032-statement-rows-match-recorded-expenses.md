# ADR-0032: A statement row counts as already recorded when a live expense matches its amount and currency within one day

> **Status:** accepted (2026-10-06)
> **Date:** 2026-10-02
> **Related plan(s):** Plan 0027 ([0027-bank-statement-import.md](../plans/done/0027-bank-statement-import.md))

## Context

Plan 0027 imports a bank statement's card purchases. Most of them may already be in the ledger,
recorded by hand («450 кофе»), from a receipt (Plan 0014) or from the bank's SMS (ADR-0021).
Recording them again doubles the month. None of those sources shares an identifier with the
statement. A hand-recorded expense has no merchant and its own description. A receipt has a
fiscal id the bank never sees. An SMS key is a hash of the SMS text.

Dates disagree too. A card purchase is often booked a day after it was made, and a statement may
list the booking date. A hand-recorded expense carries the date the user typed.

## Decision

A statement row is **already recorded** when a live expense in the same ledger has the same
amount in minor units, the same currency, and an `occurred_on` within one day either side of the
row's date. Matching is one-to-one: each expense absorbs at most one row. Rows are matched in
statement order, and each takes the closest-dated unmatched candidate (ties go to the earlier
`occurred_at`, then the lower id). The amount compared is the row's original amount and currency
when the statement shows one, the same choice ADR-0021 made for SMS. Matched rows are skipped by
default and listed, and the user can record them anyway.

Each recorded row's `source_key` is `stmt:<bank>:<sha256 of the row's normalised fields and its
ordinal among identical rows in the file>:<ledgerId>`. Re-sending the same file therefore records
nothing, through the source key as well as the match.

## Consequences

### Positive
- Works against every source of expenses, including hand-typed ones with no merchant.
- Lagged booking dates still match.
- Simple enough to explain in the preview: «уже записано: та же сумма в пределах дня».

### Negative
- False matches: two different 450 RSD coffees a day apart, one recorded by hand and one
  forgotten, read as one. The preview lists matched rows, and [Записать и их] records them, but
  only a user who reads the list notices.
- A hand-recorded amount that differs from the bank's (a typo, a tip added later) never matches,
  so it gets recorded twice. The user deletes one.
- The match can't use the merchant, because most expenses have none.

## Alternatives considered

### Alternative A: exact date plus amount plus merchant
Fewer false matches. It lost because hand-recorded and receipt expenses would never match (no
merchant, or a different spelling of it), so the common case would double.

### Alternative B: no matching, only the source key
Re-sending a file is safe, but every purchase already recorded by hand or SMS would be imported
again. It lost because that is exactly the case the feature exists for.
