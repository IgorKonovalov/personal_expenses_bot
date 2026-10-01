# ADR-0017: Budgets run over payday periods, with a cumulative daily allowance in the budget's currency

> **Status:** accepted (2026-10-01)
> **Date:** 2026-09-30
> **Related plan(s):** [Plan 0011](../plans/done/0011-budgets.md)

## Context

The user wants a budget that answers "how much can I still spend today", not only "how much is
left this month". ZenMoney's "spending limit for a period" widget is the reference. The period is
often payday to payday (the 10th to the 9th), not a calendar month. The widget shows a daily
figure, computed one of two ways. "Average" divides what's left by the days remaining. "Cumulative"
gives each day a fixed share and carries yesterday's leftover or overspend forward.

Three of our rules constrain the design. Money is integer minor units, so a limit divided by the
days in a period needs a stated rounding rule. Periods are computed in local dates in the
effective timezone (`ledger.timezone ?? user.timezone`, ADR-0015). Expenses keep their original
currency and there is no FX yet (ADR-0003), so a ledger can hold RSD and EUR expenses that can't
be summed.

## Decision

> A ledger has at most one budget. It holds an optional overall limit, an optional cap per
> category, a scope (`all` or `optional`: only expenses in categories not marked essential) and a
> period start day from 1 to 31. The current period for a local date `D` starts on
> `min(startDay, last day of the month)` in `D`'s month if `D` is on or after that day, and
> otherwise in the previous month. It ends the day before the next period's start.
>
> The overall limit `L` over an `N`-day period gives a cumulative allowance through day `d` of
> `floor(L * d / N)`. What's left today is that allowance minus everything counted from the
> period's first day through today. Overspend is therefore taken from the next days, and leftover
> carries forward. On the last day the allowance is exactly `L`, so the floor's remainder is never
> lost. Category caps have no daily figure. They show spent and cap for the period.
>
> A budget's amounts are in one currency, the ledger's default currency at the time the budget was
> last set. Only expenses in that currency count toward it. The others are listed as "not
> counted", and there is no conversion. All of this is computed at read time from `expenses`, and
> nothing is materialised.

## Consequences

### Positive
- A payday period is a start-day setting, not a second period kind. Day 1 gives calendar months
  through the same code.
- The cumulative formula is a pure function of `(L, N, d, spentThroughToday)` with no per-day
  state. Edits, deletions and past-dated expenses are right on the next read.
- `floor(L * d / N)` is exact on the last day and never overshoots on earlier days, so there's no
  rounding drift to test for.
- Group ledgers get one period edge for free from ADR-0015.

### Negative
- Expenses in other currencies are silently excluded from the budget (the screen lists them, but
  the daily figure ignores them). A user who spends in two currencies gets a misleadingly low
  total until the FX plan lands.
- A start day of 29 to 31 gives periods of uneven length around February. A start day of 31 in
  2027 gives Jan 31 to Feb 27 (28 days), then Feb 28 to Mar 30 (31 days).
- Setting the limit mid-period counts everything since the period started, including spending
  from before the budget existed. That's correct, but it can surprise the user.
- There are no planned payments in the formula (ZenMoney subtracts them), because recurring
  expenses don't exist yet.

## Alternatives considered

### Alternative A: Average daily allowance
The day's figure is `(L − spent before today) / days remaining`. It spreads an overspend thinly
over the rest of the period, so the number barely moves after a big purchase. The user chose
cumulative, where yesterday's overspend is visible today. That's also the only mode ZenMoney
ships on iOS.

### Alternative B: Calendar months only
This is simpler: `monthOf` already exists. But payday-to-payday is the most common case in
ZenMoney's own docs, and a start day costs one pure function plus a settings row.

### Alternative C: Convert other-currency expenses into the budget currency
This needs a rate source, which is the FX plan's ADR (ADR-0003 defers it). Building it inside
budgets would bundle two decisions. The listed "not counted" line is the honest stopgap.
