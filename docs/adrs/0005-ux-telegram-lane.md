# ADR-0005: Add a ux-telegram lane that designs and reviews chat UX but writes no code

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** none

## Context

The whole product is a chat. Its quality depends on copy, button layout, confirmations and
empty/error states as much as on the domain code. Several of our correctness rules also reach the
user as UX: the ledger-naming confirmation (ADR-0002), the ambiguous-amount question (ADR-0004),
and approximate converted totals (ADR-0003).

The sibling `traditional-medicine-notifier-bot` ran a `ux-telegram` skill alongside
`architect` and `dev`. Its plans tagged chat-facing phases "dev (with ux-telegram review)". That
skill was never committed, which is why it was recovered from a local copy. `CLAUDE.md` requires an
ADR to add a lane.

The existing loop rests on one rule: the architect designs and `dev` builds. A new lane must not
blur who writes code or plans.

## Decision

We add a **`ux-telegram`** skill. It designs and reviews flows, copy, keyboards and empty/error
states, checked against Telegram's limits and our ADRs. It **delivers its output in the
conversation only**: it writes no code, no plans and no ADRs. The user carries its designs into
`/architect` (to become plan phases or an ADR) and its review findings into a `/dev` fix pass.
Like the other lanes, it never auto-invokes another skill. Plan phases keep exactly one owner tag
(`dev` or `human`). UX review isn't an owner.

## Consequences

### Positive
- Chat-facing plans can get a dedicated UX pass before they're written, and a copy/flow review
  after they ship, without adding UX rules to the architect skill.
- Ownership stays unchanged: `dev` owns the messages module and all code, and the architect owns
  `docs/`.

### Negative
- One more manual handoff. A UX finding reaches the code only if the user carries it to
  `/architect` or `/dev`.
- The lane's rules partly overlap with `architect/references/best-practices.md` (Telegram
  limits). The UX references point there for correctness and keep only the user-facing side, but
  the two can drift.

## Alternatives considered

### Alternative A: Fold UX into the architect skill
There'd be no new lane. It lost because it grows the architect skill by accretion, which is
exactly the failure `CLAUDE.md` warns about, and design review of copy is a different activity
from system design.

### Alternative B: Let ux-telegram edit the messages module directly
Copy changes would take one step less. It lost because the messages module is code, with keys,
parameters and tests, and "dev writes all code" is the invariant the loop relies on.
