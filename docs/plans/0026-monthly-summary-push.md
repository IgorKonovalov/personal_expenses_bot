# 0026: Monthly summary push: last period's report arrives on its own

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0017](../adrs/0017-budgets-payday-periods-cumulative-allowance.md)
> (payday periods). Depends on the scheduler that Plan 0025 introduces.

## TL;DR

When a period closes (the 1st of the month, or the budget's payday when one is set), the bot
sends the ledger the closed period's report without being asked: the total, categories by amount,
the change against the period before, and how the budget ended. It is the existing `/month`
report plus a comparison, computed without AI, so it costs nothing per user.

## Context & problem

Market check (2026-10-01): Cointry sends a monthly report and sells an AI analysis of it. The
bot answers `/month` only when asked, so a user who stops asking stops looking, and the habit
dies. A push at the period boundary is the cheapest way to bring them back.

## Questions for the interview

- Calendar month, or the budget's period when one exists? Both, if they differ?
- What's in it beyond `/month`: the change per category against the previous period, the top
  expenses, the budget's end result?
- Opt-out (on by default?) and where the switch lives (`/settings`).
- Group ledgers: one message to the group, at the ledger's timezone?
- Delivery at a sane local hour (not 00:00), and exactly once per ledger and period across
  restarts.
- A weekly variant, or not?
- A one-line `/donate` footer on the push (Plan 0028 and ADR-0027 leave it to this plan).

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- AI-written insights or advice (a per-use cost; out by the donations-only model).
- Charts as images.

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
