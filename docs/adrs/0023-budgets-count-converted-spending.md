# ADR-0023: Budgets count spending in every currency, converted into the budget's currency

> **Status:** accepted (2026-10-01)
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0022](../plans/done/0022-converted-totals-nbs.md)

## Context

ADR-0017 counts only expenses in the budget's currency toward the limit, the daily allowance and
the category caps. Everything else is listed as "Не учтено, другая валюта". It said this itself
was a cost: a user who spends in two currencies gets a misleadingly low figure until FX lands.
ADR-0022 lands FX. The user's budget is RSD, and their online charges arrive in USD and EUR.

## Decision

> Every expense in the budget's period counts toward the budget. One already in the budget's
> currency counts exactly. Any other is converted into the budget's currency by ADR-0022's rule
> (its `occurred_on` day's NBS list, half-up, rounded per expense) before it is summed into
> `spentInPeriod`, `spentThroughToday` and each category's cap. Only an expense with no rate is
> left out, and the budget screen lists it as "Не учтено, нет курса". The target is the budget's
> `currency`, not the ledger's default, so a budget left in an old currency after a currency
> change still sums correctly. This supersedes ADR-0017's sentence "Only expenses in that currency
> count toward it". The rest of ADR-0017 (periods, the allowance formula, caps, scope) stands.

## Consequences

### Positive
- The daily figure on every expense card includes the USD subscription and the EUR flight.
- The allowance formula is unchanged: it still sees one integer sum in one currency.
- A budget whose currency differs from the ledger's is no longer stuck, because its spending
  converts too.

### Negative
- The budget's "spent" moves if NBS corrects a rate, and it shifts by the day's rate rather than
  what the card was charged.
- A fresh expense before the day's list is stored uses the previous list, up to 4 days back
  (ADR-0022), so the morning's card can differ slightly from the evening's screen.
- Budgets now depend on the rate worker. A long outage drops foreign spending out of the budget,
  though the screen says so.

## Alternatives considered

### Alternative A: keep budgets in one currency (ADR-0017 as is)
It's exact and needs nothing new. It lost because the user asked for foreign spending to count,
and ADR-0017 named this exclusion as its main cost.

### Alternative B: convert into the ledger's default currency
One target for reports and budgets. It lost because the budget's limit and caps are stored in the
budget's currency. Converting into anything else would compare amounts in two currencies.
