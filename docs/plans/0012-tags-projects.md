# 0012: Tags for projects: `#отпуск` on an expense, and a report per tag

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-09-30
> **Related ADRs:** none yet. A parser ADR is expected (it extends ADR-0004's expense text).

## TL;DR

An expense can carry one or more tags next to its category: `450 кофе #отпуск`. A tag cuts across
categories, for example a trip, a renovation or a side project, and gets its own report: how much
went into `#отпуск`, by category. The idea comes from ZenMoney's "projects as a second category".
There, a `#`-prefixed category goes second on an operation, and the category report filters by
it.

## Context & problem

Categories answer "what kind of spending". They can't answer "what was this trip's total",
because the trip's expenses are spread over Кафе, Транспорт and Жильё. Today the user would have
to add them up by hand from `/month`.

## Questions for the interview

- Is a tag free text created on first use, or chosen from a list? Can one expense carry several
  tags?
- Does `#` stay in the description, or get stripped from it? Does suggestion history (ADR-0008)
  learn tags too?
- Which report: `/tag отпуск` for all time, or a period? Does a tag belong to a ledger (like
  categories, ADR-0007)?
- Adding and removing a tag in the edit flow. Tags in group ledgers.
- Does a "trip" also switch the ledger's default currency for its duration? (That's a bundle to
  avoid, or a follow-on plan.)

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- Budgets per tag (after [Plan 0011](0011-budgets.md), if wanted).

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
