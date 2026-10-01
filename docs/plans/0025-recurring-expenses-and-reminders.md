# 0025: Recurring expenses and reminders: rent and subscriptions recorded on their day

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0015](../adrs/0015-shared-ledgers-carry-a-timezone.md) (ledger time).
> A scheduler ADR is expected: this plan introduces the bot's first user-facing scheduled job.

## TL;DR

The user marks an expense as recurring ("каждый месяц 1-го") from its card or from a `/recurring`
list. On that day, in the ledger's timezone, the bot either records it and posts the card with
[Удалить], or asks first with [Записать] / [Пропустить]. Reminders without an amount ("заплатить
за интернет") are the same schedule with no expense attached.

## Context & problem

Market check (2026-10-01): Mobs offers scheduled payments and reminders, and Cointry lists
recurring transactions as coming. Fixed monthly costs are the expenses users most often forget
to record, and a budget (Plan 0011) that misses rent is wrong for the whole period. The bot has
background workers (receipts, rates), but nothing that fires per user at a local time.

## Questions for the interview

- Record automatically, or ask each time? Per rule, or one setting?
- Schedule shapes: monthly on day N (what about the 31st in a 30-day month: last day?), weekly,
  yearly. Anything more is out.
- Downtime: the bot was down on the 1st. Does it catch up once on boot, and never twice
  (idempotency key = rule + occurrence date)?
- A recurring amount in a foreign currency, and a budget that counts it before the day arrives?
- Group ledgers: who owns a rule, and where does the card go?
- Is the scheduler shared with Plan 0026 (monthly summary) and Plan 0013's repay reminders?

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- Income or salary as a recurring entry (the bot has no income).
- Detecting recurring spending automatically from history.

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
