# 0024: Export and data ownership: every expense out as CSV or XLSX, free

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0002](../adrs/0002-ledgers-and-identity.md) (export per ledger),
> [ADR-0020](../adrs/0020-sealed-ledgers-write-open-read-locked.md) (sealed ledgers). An ADR is
> expected if XLSX brings a dependency.

## TL;DR

`/export` sends the active ledger's expenses as a file in the chat: date, amount in minor units
rendered exactly, currency, category, description, author (in a group ledger) and, for a
receipt, the shop. It is free and unlimited. Together with the encrypted ledger (Plan 0019) it
makes the public promise "your data is yours: take all of it out, any time".

## Context & problem

Market check (2026-10-01): Cointry puts CSV export behind its paid tier, and Mobs sells "your
data stays in your own sheet" as its main pitch. Today a user of this bot can't get their data
out at all, which is a reason not to start using it. Export is the cheapest feature on the list
that answers that objection.

## Questions for the interview

- CSV only (no dependency), or XLSX too (a dependency, ADR-0001's cost rule)? CSV with a BOM and
  `;` so Excel opens Cyrillic correctly?
- One period (`/export` → month picker) or everything? Converted totals (ADR-0022) or original
  amounts only?
- Receipt line items: a second sheet/file, or omitted?
- A sealed ledger (Plan 0019): export only while unlocked? Is the file itself a privacy hazard in
  the chat history?
- Group ledger: may any member export, or only the person who added the bot?
- Does "data ownership" also mean a "delete everything" command before public release?

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- Import from a file (bank statements are Plan 0027).
- Live sync to Google Sheets. It's a running integration with OAuth and a token to guard.
- Scheduled exports (Plan 0026 could attach one later).

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
