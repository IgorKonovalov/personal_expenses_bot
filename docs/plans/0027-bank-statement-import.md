# 0027: Bank statement import: a Serbian bank's export file becomes expenses

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0021](../adrs/0021-bank-sms-template-parsers-plain-expense.md) (bank SMS
> templates), [ADR-0004](../adrs/0004-amount-parsing-rule.md). An ADR is expected for matching
> statement rows against expenses already recorded.

## TL;DR

The user sends the bot a statement file exported from their bank's e-banking. The bot reads its
card purchases, skips the ones already recorded (from an SMS, a receipt or by hand), shows what's
left as one preview, and records them on [Записать все]. It catches up a month the user didn't
track, in one step.

## Context & problem

Market check (2026-10-01): Auritrack imports bank statements (PDF, CSV, Excel). The SMS parser
(Plan 0021) covers one purchase at a time, and only when the user forwards it. A statement covers
everything, including what the user forgot. The hard part isn't parsing: it's not recording a
purchase twice when it already arrived by SMS or receipt.

## Questions for the interview

- Which banks and which format first? A real, anonymised sample file is required before phases
  can be designed (no real user data in fixtures).
- CSV/XLSX only, or PDF too (a dependency and much harder)?
- Deduplication: match on date + amount + currency, or also the merchant? What does the preview
  say for a probable duplicate?
- Card currency vs charged currency (the same question ADR-0021 answered for SMS).
- Re-sending the same file records nothing (idempotency per statement row).
- Private chats only, like SMS and receipts?

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- Live bank connections (open banking). Not available for these banks, and a credential to guard.
- Income, refunds and transfers in the statement. Card purchases only.

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
