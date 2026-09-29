# ADR-0003: Store original amounts; convert to the viewer's home currency at report time

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0001](../plans/0001-scaffold-walking-skeleton.md) (storage shape only; conversion is a later plan)

## Context

Receipts and bank SMS arrive in RUB, KZT, RSD and EUR, and more countries are planned. The user
wants single-number totals ("this month: 1 234.56 EUR"), not one line per currency.

A shared ledger can have members with **different home currencies**, so one expense can need two
different converted values at the same moment. A user can also change their home currency. Rates
move daily, and an expense's rate should be the one for the date it happened.

**Unverified:** rate-source coverage. The ECB reference rates have not published RUB since March
2022, so a single ECB feed does not cover the required set. The FX plan must pick a source (or
several national-bank feeds) that covers RUB, KZT, RSD and EUR, and record it in its own ADR.

## Decision

`expenses` stores only the **original** `amount_minor INTEGER` + `currency TEXT` (ISO-4217).
Conversion happens **at report time**, in the domain money module. Each expense is converted to
the **viewer's** `home_currency` at the rate for its `occurred_on` date, looked up in a dated
rate table (`fx_rates`) that a scheduled job fills. Each converted expense is rounded to the
target's minor units **before** summing, so a total is always the sum of the displayed parts. The
rounding mode (half-even vs. half-up) and the rate representation (scaled integer, never `REAL`)
are pinned by the FX plan. If a rate is missing for a date and currency, the report shows that
currency's total **unconverted, on its own line** instead of guessing. Converted totals are
labelled as approximate and name the rate date.

Until the FX plan lands, reports group totals by currency (Plan 0001).

## Consequences

### Positive
- One stored truth per expense. Changing home currency or fixing a bad rate re-renders every
  report correctly with no data migration.
- Members of a shared ledger each see totals in their own home currency.
- This composes with encrypted personal ledgers (ADR-0002): conversion runs after decryption,
  in memory.

### Negative
- Reports depend on a rate table being populated. The rate job becomes operationally important,
  and a gap degrades totals, though visibly.
- Historical reports can shift if a rate is corrected after the fact. The receipt amount stays
  exact, but the converted view does not freeze.
- Converting every row at report time costs CPU. That's negligible at personal scale.

## Alternatives considered

### Alternative A: Convert at record time and store the converted amount
It freezes the number the user saw. It lost because a converted value belongs to a *viewer*, not
to an expense: shared-ledger members with different home currencies, and any home-currency change,
make a single stored value wrong.

### Alternative B: Group by currency, never convert
It's exact and needs no rate source. It lost because the user explicitly wants single totals. It
survives as the fallback when a rate is missing.
