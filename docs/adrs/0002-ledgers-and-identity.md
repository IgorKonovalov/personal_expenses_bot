# ADR-0002: Expenses belong to ledgers; users select an active ledger

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0001](../plans/0001-scaffold-walking-skeleton.md)

## Context

The bot starts with one person and their family, and open signup is a stated future direction.
A user wants two kinds of books: a **personal** one and one or more **shared** ones (the family,
possibly a trip). Each book can live in a different currency: a family in Serbia spends RSD while
a personal ledger may be in EUR.

Optional user-held encryption is planned for **personal ledgers only**. Shared ledgers stay
plaintext, because every member must read them and per-member key wrapping is out of scope. When
a ledger is encrypted and locked, the server can't read amounts, so SQL `SUM()` stops working for
it. Report-time currency conversion (ADR-0003) also needs per-row processing. Both push
aggregation out of SQL.

The sibling bot keyed data by user and had to retrofit per-user timezone. Adding ledgers
afterwards would be the same kind of retrofit.

## Decision

Every expense belongs to a **ledger**, never directly to a user. Signup creates an internal
`users.id` (UUID) and one `personal` ledger for that user. The Telegram id lives in
`auth_identities(provider, external_id)` and is never a key. Shared ledgers have members via
`ledger_members`. Each user has an **`active_ledger_id`**, and every expense, receipt and SMS goes
to the active ledger. Every confirmation names the target ledger, and a later plan adds a one-tap
"move to…" button. Each ledger has a `default_currency`, used when the user's text names none.
Each user has an IANA `timezone` from the first migration.

**Aggregation happens in application code** (domain functions over repository rows), not in SQL
`SUM()`. This way, encrypting a personal ledger or converting currencies doesn't rewrite every
report. Every repository query is scoped by ledger membership.

## Consequences

### Positive
- Personal and shared books, plus per-ledger currency, are expressible from day one with no
  schema retrofit.
- The encryption plan becomes a column-level change on `expenses` for `personal` ledgers, not a
  redesign.
- Open signup needs no ownership model change. Membership scoping is already the access rule.

### Negative
- One extra join (membership) on every read, and one extra concept for the user ("which ledger am
  I in?"). A wrong active ledger silently misfiles expenses, so the confirmation must always name
  the ledger.
- In-app aggregation loads rows into memory. That's fine at hundreds to thousands of rows per
  ledger-month. It would need revisiting if a ledger reached hundreds of thousands of rows.
- `occurred_on` in a shared ledger is the *author's* local date. Two members in different
  timezones can disagree about "today" by a few hours. This is accepted: it matches what each
  author meant.

## Alternatives considered

### Alternative A: Expenses owned by a user, with an `is_shared` flag
It's simpler for a single user. It lost because it can't express two shared books (family vs.
trip), per-book currency or per-book export, and moving to ledgers later would mean migrating
every row.

### Alternative B: Ask which ledger on every expense
It never misfiles. It lost because it adds a tap to every expense forever, and misfiling is
mitigated by naming the ledger in the confirmation plus a move button.

### Alternative C: Encrypted shared ledgers with per-member wrapped keys
It's the principled E2E-like design. It lost for now because adding a member requires an unlocked
existing member plus key-wrapping flows, which is complexity that no current user needs. If needed,
a future ADR supersedes the "personal only" scope.
