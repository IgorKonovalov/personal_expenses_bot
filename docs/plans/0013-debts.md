# 0013: Debts: who owes whom, closed in the currency they were opened in

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-09-30
> **Related ADRs:** [ADR-0003](../adrs/0003-currency-conversion-at-report-time.md). A debt model
> ADR is expected.

## TL;DR

The user records money lent or borrowed against a person's name ("дал Пете 5000", "взял у Ани 20
EUR"), sees open balances per person, and closes a debt by recording the repayment. It's modelled
on ZenMoney's debt operations: «Я дал в долг» / «Я взял в долг», closed by the reverse operation,
and **always in the currency the debt was opened in**, so exchange rates can't turn a settled
debt into a new one. That rule matches ADR-0003: we already store original amounts.

## Context & problem

A loan isn't an expense. Recording it as one inflates the month, and recording the repayment has
no home at all, since the bot has no income. ZenMoney's help center also covers a shared bill
paid by card and repaid in cash: record only your share, and treat the rest as money owed back.
Plan 0009 explicitly excludes settle-up in group ledgers, which is the same problem among group
members.

## Questions for the interview

- Is a counterparty free text ("Петя") or a Telegram user? Should debts between members of a
  group ledger be the settle-up Plan 0009 deferred?
- Is the syntax free text (`дал Пете 5000`) or a flow from `/debts`? How does it avoid colliding
  with expense parsing (ADR-0004)?
- Splitting a bill: does `1200 кафе /3` record 400 as the expense and 800 as debts owed to me?
- Partial repayments. A debt in a currency other than the ledger default. Undoing a repayment.
- Is a debt per ledger or per user? Can a debt be private in a shared ledger?
- Splitting a receipt by its line items (added 2026-10-01 from the market check): a receipt card
  with items (Plan 0014) offers [Разделить], each item is assigned to me or to a person, and the
  others' items become debts owed to me. SplitFast sells this with AI photo reading; we already
  have exact items from the tax site. In this plan, or a follow-on once debts exist?
- Debt simplification across several people (A owes B, B owes C → A owes C): wanted, and only
  within one currency?

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- Loans with interest schedules, or credit accounts (ZenMoney's "Кредит" account type). The bot
  has no accounts.
- Reminders to repay (the notifications/scheduler plan).

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
