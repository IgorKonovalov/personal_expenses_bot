# 0028: Donations: everything free, `/donate` via Telegram Stars and an external link

> **Status:** draft (stub: the interview hasn't run, and the phases aren't designed)
> **Created:** 2026-10-01
> **Related ADRs:** none yet. An ADR is expected for the funding model (donations only, no paid
> tier) and its rejected alternatives.

## TL;DR

The bot stays free, with no paid tier and no feature limits, and says so. `/donate` (and a line
in `/help`) offers a few fixed Telegram Stars amounts paid through a Stars invoice, plus a link to
an external donation page for people who prefer a card. A donation unlocks nothing; the bot says
thank you.

## Context & problem

Market check (2026-10-01): every comparable bot is freemium (Cointry, Mobs, Auritrack), with
limits or paid export, voice and editing. The product decision is donations after public
release, no paid services. Stars work for users whose cards can't pay foreign services, which
fits the Russian-speaking audience. App stores take about 30% when Stars are bought on mobile,
and payouts go through Fragment to TON after a holding period (unverified details; check the
current Telegram terms during the interview).

## Questions for the interview

- Which external channel: Boosty, Tribute, GitHub Sponsors, Ko-fi? One or two?
- Fixed Stars amounts, and the wording of the "free forever" promise.
- Where it surfaces: `/donate`, `/help`, the monthly summary (Plan 0026)? Never in expense cards.
- Do we store donations (amount, user), or let Telegram's records be the record?
- Refunds (`refundStarPayment`) and the `pre_checkout_query` handling grammY needs.
- Is this gated on public release, i.e. on opening `ALLOWED_TELEGRAM_IDS`, which has no plan
  yet?

## Implementation phases

Not designed yet. The interview comes first. Every phase will carry an `**Owner skill:**` tag and
a behavioral **Done when** before this plan moves to `approved`.

## What this plan does NOT do

- Paid features, subscriptions or donor perks.
- Opening the bot to the public (access, abuse limits, privacy policy). That's its own plan.

## Implementation log

_(Empty until the plan is designed and approved.)_

## Followups
