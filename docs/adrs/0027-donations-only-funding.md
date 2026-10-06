# ADR-0027: The bot is funded by donations only: no paid tier, and a donation unlocks nothing

> **Status:** accepted (2026-10-06, at the close of Plan 0028)
> **Date:** 2026-10-01
> **Related plan(s):** Plan 0028 ([0028-donations.md](../plans/done/0028-donations.md))

## Context

The bot is about to admit strangers (Plan 0029). Its running cost is small: one container on a
shared VPS, with no per-user API spend and no AI calls. Every comparable bot in the 2026-10-01
market check (Cointry, Mobs, Auritrack) is freemium, holding back export, voice, editing or
reports behind a subscription.

A paid tier is a product of its own. It needs entitlement checks in every gated handler, a
subscription lifecycle (renewal, expiry, grace, refunds), and copy that keeps telling the user
what they're missing. It also turns "your data is yours" (Plans 0019 and 0024) into a sales
pitch. Most of the audience pays with cards that can't reach foreign services, so the payment
rail matters as much as the model. Telegram Stars works for them: they're bought inside Telegram,
and the app stores take their cut on mobile.

## Decision

Every feature is free for everyone, with no limits beyond abuse guards (Plan 0029). The bot
accepts voluntary donations in Telegram Stars at a few fixed amounts, plus an optional external
page (`DONATE_URL`, for example Ko-fi) for card payers. A donation unlocks nothing and changes
nothing about how the bot treats the donor beyond a thank-you. The bot asks only in places the user
went looking (`/donate` and a `/help` line) and in the monthly summary (Plan 0026). It never asks
in expense cards, reports or errors. Each donation is stored as a minimal row (user, Stars amount,
Telegram charge id, time), so a refund can be made and a redelivered payment counted once.

## Consequences

### Positive
- No entitlement code, so no handler has a "paid?" branch and no feature can break for a lapsed
  subscriber.
- "Free, and your data is yours" is a clean public promise that competitors can't match without
  dropping their model.
- Stars need no merchant account, no card processor and no tax setup on our side for a voluntary
  digital payment.

### Negative
- Revenue is unpredictable and probably below the running cost of a hobby VPS's share. That's
  accepted: the bot is not a business.
- Stars pay out through Fragment, after a holding period, at a rate below the buy price
  (unverified figures; Telegram's terms move). The Stars a donor spends are worth less to us than
  they paid.
- We store a small payment record per donation. It is personal data, kept even after
  `/delete_account` (Plan 0029), because a refund needs it. The privacy policy must say so.

## Alternatives considered

### Alternative A: freemium with a Stars subscription
Gate export, receipts or groups behind a monthly Stars subscription. This is the market norm and
has more predictable revenue. It lost because it needs entitlement checks across every gated
handler and a subscription lifecycle, and because a paywall contradicts the data-ownership
promise that sets the bot apart.

### Alternative B: no money at all
No donation surface, so no payment code and no stored payment data. It lost on the owner's product call
(2026-10-01) to offer a way to give once the bot is public. Stars make that cheap: a few handlers
and one table separate "no" from "yes".
