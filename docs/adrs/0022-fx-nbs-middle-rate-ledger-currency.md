# ADR-0022: Reports convert into the ledger's default currency at the NBS middle rate of each expense's day

> **Status:** accepted (2026-10-01)
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0022](../plans/done/0022-converted-totals-nbs.md)

## Context

A week's digest today prints one block per currency (`3 870.00 RSD`, `107.40 EUR`, `6.00 USD`),
and the user wants one total in RSD. ADR-0003 decided the shape: store originals, convert at
report time at the rate of each expense's `occurred_on`, round each converted expense before
summing, and show a currency with no rate unconverted. It left three things open: the rate source,
the rounding mode and the rate representation. It also named a per-viewer `home_currency` as the
target, a column that was never built. The only currency setting is `ledgers.default_currency`.

The user's money is in Serbia: an RSD card, RSD budget, foreign charges in EUR and USD. The
National Bank of Serbia (NBS) publishes an official middle rate list against RSD every business
day. The list is public with no key. Verified on 2026-10-01: the page
`webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/IndexByDate` returns, for any date, the list
in force that day (a Sunday returns Friday's list), with a link to an XML download. Each XML item
carries `Currency`, `Unit` (1, or 100 for JPY and HUF) and `Middle_Rate` with four decimals. The
list covers EUR, USD, RUB and most of our currency table, but not AMD, GEL, KZT, UAH or UZS.

## Decision

> Reports and budgets convert every expense into one target currency: the ledger's
> `default_currency` for reports, and the budget's own `currency` for budgets (ADR-0023). Rates
> are the NBS middle rates, fetched by a worker into a global `fx_rates` table. Each calendar day
> maps to the NBS list in force on that day. An expense converts at its `occurred_on` day's list;
> a day with no stored list borrows the latest stored day up to 4 days earlier, and beyond that
> the expense is unconverted.
>
> A rate is stored as the integer `middle_e4` (RSD per `unit` units, times 10^4), parsed from the
> decimal string, never through a float. A conversion from currency C to target T is one exact
> rational step: `amountMinor * (rateC / unitC) / (rateT / unitT) * 10^(expT - expC)`, where RSD
> is rate 1 unit 1. It rounds once, half-up, to T's minor units. A total is the sum of the
> rounded parts. An expense already in T is never converted.
>
> A report with any converted expense marks its total `≈` and names the source ("по курсу НБС на
> день траты") with the original foreign totals. Expenses without a rate keep their old
> per-currency block, after the converted one. This replaces ADR-0003's per-viewer target with the
> ledger's currency. The rest of ADR-0003 stands.

## Consequences

### Positive
- One number per report in the currency the ledger already uses. No new setting.
- The NBS middle rate is what Serbian banks quote around, and it's the official source, not a
  mirror.
- RSD is the pivot, so a EUR ledger gets USD -> EUR through the same formula with no second feed.
- Integer storage and one rounding per expense: a total always equals the sum of its shown parts.
- Rates are public data. They carry nothing private, and Plan 0019's sealing doesn't touch them.

### Negative
- Members of a shared ledger see one currency, the ledger's, not each their own. A per-viewer
  target needs a new setting and a new ADR.
- AMD, GEL, KZT, UAH and UZS have no NBS rate, so they always show unconverted.
- Scraping: the XML link is read out of an HTML page, and the XML items out of a fixed shape. An
  NBS redesign breaks the worker. Reports then degrade to unconverted blocks, visibly.
- The middle rate isn't what the card was charged. A USD purchase on an RSD card shows a few
  percent off the bank statement.
- Converted history moves if a rate is corrected after the fact (inherited from ADR-0003).

## Alternatives considered

### Alternative A: the Kurs API mirror (kurs.resenje.org)
A free JSON API over the same NBS data, one GET per date, already filling weekends. It's the
simplest client. It lost because a one-maintainer third-party mirror with no SLA sits between us
and an official source that is reachable directly with two GETs.

### Alternative B: a global free feed (fawazahmed0 currency-api)
It covers every currency against any base, KZT included. It lost because the user picked the
official Serbian rate, and an aggregate feed is a less authoritative source with no stated
methodology.

### Alternative C: a per-viewer report currency
A new `users.report_currency`, as ADR-0003 imagined. It lost for now because there's one
currency-holding setting already, the ledger's, and no user has asked to see a shared ledger in
a different currency from its other members.

### Alternative D: round half-even
Banker's rounding removes the upward bias over many half-cent ties. It lost because each part
is shown to the user and checked by hand, and half-up is what a person computes. With four-decimal
rates, an exact tie needs the product to end in `5000`, which is rare.
