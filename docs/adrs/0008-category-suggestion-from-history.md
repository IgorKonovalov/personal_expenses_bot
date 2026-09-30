# ADR-0008: Suggest a category from the ledger's history, then keyword rules, then «Другое»

> **Status:** accepted (2026-09-30)
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0003](../plans/done/0003-categories.md)

## Context

`450 кофе` has to land in a category without an extra tap, or recording stops being a one-line
habit. The same descriptions repeat constantly in a household ("кофе", "такси", "Лидл"), and the
family's own choice for a description is the best predictor of the next one. A static list can't
know that "Лидл" is Продукты for this family, or that "кружок" goes to a custom category.

Expense text is private (see `CLAUDE.md`), and personal ledgers may be encrypted later
(ADR-0002).

## Decision

On record, the service picks a category in three steps, all deterministic and all local:

1. **History.** Find the most recent non-deleted expense in the **same ledger** with the same
   `description_key` and a non-archived category, and use that category. `description_key` is
   computed in the domain: `toLocaleLowerCase('ru')`, `ё` → `е`, trimmed, inner whitespace
   collapsed. It's stored on `expenses` with an index on `(ledger_id, description_key)`.
2. **Keyword rules.** `src/domain/categoryPresets.ts` maps keywords to a `preset_key`. The first
   description word that starts with a keyword picks the ledger's non-archived category with that
   `preset_key`.
3. **Fallback.** Use the ledger's `other` category.

The confirmation always shows the chosen category and a button to change it. Changing it
**is** the learning signal: the corrected expense becomes the most recent match for its key.

## Consequences

### Positive
- Needs no external API, costs nothing, adds no latency, and sends no expense text anywhere.
- One correction teaches the bot, and the lesson is visible and reversible.
- Pure domain functions (normalisation, keyword match) with one repository query. Fully
  unit-testable.

### Negative
- Only exact-key matches learn. "кофе латте" doesn't learn from "кофе" (the keyword rule may
  still catch it).
- `description_key` is a second plaintext copy of the description. **The encryption plan must
  encrypt or drop it for encrypted personal ledgers.** This ADR doesn't decide how.
- A one-off miscategorisation that isn't corrected is repeated for that description.

## Alternatives considered

### Alternative A: Keyword rules only
It's predictable. It lost because it never adapts: every store name and family-specific word
stays «Другое» until someone edits code.

### Alternative B: Always ask with a category keyboard
It never guesses wrong. It lost because it adds one tap to every expense forever, which the
user explicitly doesn't want.

### Alternative C: LLM classification per expense
It handles any wording. It lost because it sends private expense text to a third party, adds
per-message cost and latency, and makes a core path depend on an external API. Deterministic
history covers the repeat case, which dominates household spending.
