# ADR-0039: Receipt items map to products through built-in keyword rules plus per-user overrides, and unit prices are computed in exact integers

> **Status:** proposed
> **Date:** 2026-10-06
> **Related plan(s):** [Plan 0036](../plans/0036-product-prices-across-months.md)

## Context

To compare prices of the same product across months, the bot has to know that
`MLEKO 2,8%MM 1L IMLEK`, `Mleko Moja kravica 1l` and `МЛЕКО 1Л` are all milk. Item names come from
Serbian and Montenegrin tax sites, in Latin or Cyrillic, upper case, with brand, fat percentage,
pack size and shop abbreviations mixed in. Nothing on the receipt says what the product is.

A price is only comparable per unit. A month where the user bought a 2 l pack instead of a 1 l
pack isn't inflation. The name usually carries the pack size (`1L`, `0,5L`, `500G`), and a
weighed item carries its weight in the receipt's `quantity` (`0.535`). Money must stay in integer
minor units (CLAUDE.md), and `quantity` is stored as a decimal string, so the arithmetic has to
avoid floats.

Item names in a sealed ledger exist in plaintext only inside the unlocked payload (ADR-0020).

## Decision

> A built-in catalog in `src/domain/products/` lists generic products (`Молоко`, unit litre). Each
> product has keywords, matched on a normalized name: lower case, Serbian diacritics folded,
> Serbian Cyrillic transliterated to Latin, whitespace collapsed. A product can also carry
> exclusions, so that chocolate milk isn't milk. A per-user override keyed by the normalized name
> wins over the rules. It names a catalog product, one of the user's own products, or "not a
> product". Rule matches count right away, without asking, and the user corrects any name once.
> Pack size is parsed from the name, and weight or count from `quantity`. Both become integer
> thousandths of a base unit (ml, g or piece). A unit price is
> `round_half_up(total_minor * 10^6 / amount_milli)` minor units per litre, kilogram or piece,
> in integer arithmetic. A month's price is total spent over total amount, not a mean of the
> item prices. Overrides aren't stored for sealed ledgers, so their items use the rules only.

## Consequences

### Positive
- It works offline and on the box as it is. Item names never leave the server.
- Most common groceries match with no taps. The user's corrections accumulate, so each name is
  fixed once.
- Weighting the month by amount means a bigger pack doesn't skew the price.
- Rules are pure and unit-tested. Adding a keyword is a one-line change with a test.

### Negative
- The catalog is hand-made and Serbian-specific. Its coverage is unknown until measured on real
  receipts (Plan 0036 has a coverage phase for that), and it will miss things.
- A pack size the parser can't read (`10/1`, `6x1,5L` variants it doesn't know) leaves an item
  out of the unit price. The item still counts in what was spent.
- Overrides keyed by normalized name don't follow a shop that renames an item. That name then
  shows up as unmatched again.
- A sealed ledger gets no corrections, so its rule misses stay misses.

## Alternatives considered

### Alternative A: an LLM classifies item names
This needs the least work and gives the best coverage on odd names. It lost because every item
name would go to an external API, which breaks the privacy rule for expense data. It also adds a
paid dependency and a network failure mode to a bot that otherwise runs offline.

### Alternative B: the user assigns every name by hand
This is the most accurate, but a month of receipts holds dozens of distinct names, and the
review queue would never empty. Rules for the common cases leave the user only the leftovers.

### Alternative C: compare exact item names, with no generic product
This needs no catalog, but it compares only one brand at one shop. «Молоко» across brands and
shops is what the user asked to see.

## Outcome

_(Added only at acceptance if implementation falsified something above.)_
