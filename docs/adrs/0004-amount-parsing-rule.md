# ADR-0004: Amount parsing: one decimal separator, space thousands, ask on ambiguity

> **Status:** accepted (2026-09-29)
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0001](../plans/done/0001-scaffold-walking-skeleton.md)

## Context

The users type amounts from RU, KZ, RS and ME habits, where the decimal comma is normal
(`12,50`), and from EUR/English habits, where it's a dot (`12.50`). `1.200` means one thousand
two hundred in Serbia and one point two in most English contexts. A family ledger mixes both.
Recording 1200 instead of 1.2 (or the reverse) is a silent, thousand-fold error, the worst
class of bug in this product.

A per-user locale doesn't resolve it: one person pastes an EUR receipt total today and types a
RSD amount tomorrow.

## Decision

The domain money module parses an amount token by one rule, independent of the user:

- Digits may be grouped by **spaces** (regular, NBSP or thin space) in groups of exactly three:
  `1 200`, `12 345 678`.
- At most **one** `.` or `,` may appear. It is a **decimal separator** only when followed by
  1 up to the currency's minor-unit exponent digits (2 for RUB, KZT, RSD, EUR): `12,5`, `12.50`.
- A single `.` or `,` followed by **exactly three** digits (`1,200`, `1.200`) is **ambiguous**.
  The bot shows the valid readings and asks which was meant. It never guesses and never records.
  Whether the ask is a text hint or buttons is a plan-level UI choice.
- Anything else (two separators like `1.200,50`, more fractional digits than the exponent allows,
  zero or negative amounts) is a parse failure, and the bot replies with a hint.
- Minor-unit exponents come from a currency table in the money module, never a hardcoded `* 100`.

Parsers for structured sources (fiscal QR payloads, bank SMS templates) do **not** use this rule.
Each source has a known format and parses it exactly.

## Consequences

### Positive
- A thousand-fold misread can't happen silently. The only ambiguous shape costs one resend.
- The rule is locale-free, table-testable, and the same for every ledger member.

### Negative
- Users used to `1.200` for 1200 get a question every time. The tap tax falls on Serbian and
  Montenegrin habits, and `1200` or `1 200` avoids it.
- `1.200,50` (full European notation) is rejected outright rather than accepted. That may annoy
  users. A later ADR could accept the two-separator form if it becomes common.

## Alternatives considered

### Alternative A: Per-user locale decides the separators
It's natural for a single-locale user. It lost because these users switch contexts
(EUR receipts vs. RSD shops) and share ledgers across habits, so the same keystrokes would mean
different amounts for different family members.

### Alternative B: Dot is always decimal, comma always thousands (or the reverse)
It's simple and never asks. It lost because either choice silently misreads one of the two
habits present in this household by a factor of 1000.
