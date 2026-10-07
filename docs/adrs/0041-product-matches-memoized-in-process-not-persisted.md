# ADR-0041: A receipt item's product match is memoized in process, not persisted per item

> **Status:** accepted
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0038](../plans/done/0038-prices-view-cost.md)

## Context

`/prices` (Plan 0036, ADR-0039) reads all of the viewer's receipt items in a ledger on every tap.
It normalizes each name, matches it against the keyword catalog in JS, and groups the result per
product and month. On 2026-10-07 we timed it on a synthetic heavy user with 20,000 items and about
3,000 distinct names. The list took 369 ms, and 307 ms of that was `matchProduct` called once per
row. The SQL read took 21 ms and `normalize` 13 ms. Updates run one at a time (`bot.start()`,
no runner), so each tap stalls every other user's updates for that long.

The match is a pure function of the normalized name and the catalog. The catalog is code in
`src/domain/products/catalog.ts`, so it changes only with a deploy, and a deploy restarts the
process. Per-user overrides (`item_products`) are a cheap keyed read and are not part of the
match.

A sealed ledger's item names exist in plaintext only while its key is held (ADR-0020). Anything
that keeps them longer weakens the seal.

## Decision

We memoize the rule match per raw item name in a process-wide, bounded, insertion-order-evicted
map from raw name to `{ nameKey, ruleRef }`. We also compile the catalog's keywords and
exclusions into word arrays once, at module load. The views keep reading items from SQL on every
tap and keep grouping them in JS. Names from a sealed ledger never enter the shared map. They go
through a memo that lives only for one call.

## Consequences

### Positive
- Matching costs about one map lookup per row once the map is warm. The work left per tap is
  the SQL read plus grouping: about 35 ms at 20,000 items, measured as the read and normalize
  share above.
- No migration, no backfill and no catalog-version bookkeeping. A catalog edit takes effect on
  the next deploy because the map starts empty.
- `normalize` is folded into the same lookup.

### Negative
- Each tap still reads every item the user ever bought. The cost grows linearly with history,
  only with a far smaller constant.
- The first view after a deploy pays the full match cost for each name it hasn't seen.
- The map holds plaintext receipt item names from many users in memory. They are names only:
  no amounts, users or dates. Its bound, set in Plan 0038, caps the memory.
- If the catalog ever becomes runtime data (editable without a deploy), the map must be
  invalidated on each edit. That would be a new ADR.

## Alternatives considered

### Alternative A: persist the product per item

Add `name_key` and the rule's product to `receipt_items` when a receipt is fetched, stamped with
a catalog version, and backfill. Re-run the backfill whenever the version changes. The views
become a SQL `GROUP BY product, month`, a few ms at any history length. It lost on cost against
need: a migration, a backfill job, version bookkeeping, and a second source of truth that can
drift from `matchProduct`. All of that buys about 30 ms over this decision at 20,000 items.
Revisit it when the timing logged in Plan 0038 shows real users near that size.

### Alternative B: a memo per call only

Wrap `matchProduct` in a `Map` that lives for one `resolveItems` call. It is about ten lines and
cuts matching to the distinct names (49 ms for 3,000 names). It lost because it pays that again
on every tap, and every page turn and product open is a tap.
