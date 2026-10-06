# ADR-0024: Admission lives in the database, granted by admin-made invite codes

> **Status:** accepted
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0029](../plans/done/0029-opening-by-invite.md)

## Context

Until now, `ALLOWED_TELEGRAM_IDS` in `.env` decides who may use the bot. Three places read it: the
private-chat middleware, group activation (an allowlisted adder binds a group, ADR-0014) and the
group card's [Изменить в личке]. Adding a person means editing `.env` on the VPS and
restarting. That works for one household and doesn't work for strangers.

Having a `users` row can't mean "admitted". A group member who records an expense is provisioned
with a user and a personal ledger (`ensureSender` in `src/services/groupChats.ts`) without ever
being allowed in a private chat. So admission has to be its own fact.

The opening is controlled growth: the admin posts a link to a community chat and wants the first
N people in, without approving each one, and with a way to shut a leaked link off.

## Decision

> Admission is a column, `users.admitted_at`, set by redeeming an invite code and cleared by
> account deletion. `users.blocked_at` overrides it. One function, `isAdmitted(telegramId)`, is
> the only access check, used by the private-chat middleware, group activation and the group
> card. The admin (`ADMIN_TELEGRAM_ID`) is always admitted. Codes are made by the admin with
> `/invite`. Each code has a use limit, an expiry and a revoke switch, and is handed out as a
> `t.me/<bot>?start=<code>` deep link. `ALLOWED_TELEGRAM_IDS` is retired. `ADMIT_TELEGRAM_IDS`
> admits listed ids once at boot (idempotent), which moves the household over and is a recovery
> path. Removing an id from it revokes nothing; `/block` does.

The access check reads SQLite on every update, with no cache, so `/block` takes effect on the
next update without a restart.

## Consequences

### Positive
- One rule for access, changeable from the chat: invite, revoke, block, with no redeploy.
- Account deletion (Plan 0029) can drop admission in the same transaction as the data.
- Group members can still record in a group without being admitted, as today (ADR-0014).

### Negative
- A migration, plus an env rename on the VPS before the deploy. A boot with the old variable
  set fails loudly, by design, so the human phase has to edit `.env` first.
- An indexed lookup per update. Negligible at this size, but it's I/O in the hot path.
- A leaked multi-use link admits strangers until it's used up, expires or is revoked. The
  use limit bounds that.

## Alternatives considered

### Alternative A: env allowlist plus DB invites
Keep `ALLOWED_TELEGRAM_IDS` as permanent members and add DB admissions on top. It lost because it
splits the truth in two: `/block` would have to override the env, and "who's in" needs two
reads.

### Alternative B: admin approval instead of codes
A stranger presses [Попросить доступ] and the admin taps [Пустить]. It lost because every new
user waits for the admin to be awake, and the admin wants to admit a community at once.

### Alternative C: fully open, with or without a user cap
Anyone who sends `/start` gets in. It lost because the admin chose controlled growth: nothing
bounds who arrives, and a cap only bounds how many.

## Outcome

_(Added only at acceptance if implementation falsified something above.)_
