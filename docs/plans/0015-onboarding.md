# 0015: Onboarding: confirm the setup on first contact, then teach each feature when it becomes relevant

> **Status:** draft (stub: the shape is decided, but the phases aren't designed)
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0011](../adrs/0011-navigation-model.md) (menu and cards),
> [ADR-0009](../adrs/0009-persisted-flow-sessions.md) (flows). An ADR is likely for where the
> "seen" state lives.

## TL;DR

A user the bot has never onboarded gets a one-tap setup check on first contact: «Часовой пояс:
Москва, валюта: RUB — верно?» with [Да] / [Изменить]. [Изменить] opens the existing `/settings`
pickers. Then one welcome message shows what the bot can do. After that, short tips appear the
first time each feature becomes relevant, for example after the first expense, the first
«Другое», the first `/month`, or the first receipt (Plan 0014). Each tip shows once per user.
Everyone can replay the tour from `/help`.

## Context & problem

The bot has grown: categories, past dates, the edit flow, summaries, settings, and soon groups,
budgets and receipts. Today `/start` sends one welcome line with one example (`messages.welcome`),
and `/help` is owed copy from Plans 0003 and 0004 (paid in Plan 0014 Phase 6). Users are
provisioned silently on their first message (`ensureUser`), so "first start" has to mean "never
onboarded", not "first `/start`". The timezone and currency default from env, which is right for
the family but wrong for anyone else.

## Decided in the 2026-10-01 interview

- **Shape:** setup first, then contextual tips. Not a hands-on walkthrough or a card carousel.
- **Audience:** only users never onboarded get it automatically, and a replay lives in `/help`.
  Existing users don't get it pushed after the deploy.
- **Setup step:** confirm the env defaults with one tap. Don't ask for both up front.
- **Order:** after Plan 0014 (receipts), so the tips can include receipts.

## Questions for the interview

- Which tip triggers, and the copy for each (run a `ux-telegram` design pass first).
- What happens to the first message from a not-yet-onboarded user that is already an expense
  (`450 кофе` before `/start`): record it and then run the setup check, or ask first?
- Where the onboarding and tip state lives: a `user_flags` table, or columns on `users`. Is a tip
  "seen" when sent, or when acknowledged?
- Onboarding in groups (Plan 0009): does adding the bot to a group get its own short intro?
- Can the user turn tips off?

## What this plan does NOT do

- Open-signup hardening beyond onboarding (rate limits, privacy policy): Plan 0001's roadmap item 9.

## Implementation log

> Written by `dev`. Empty until the plan is approved.

## Followups
