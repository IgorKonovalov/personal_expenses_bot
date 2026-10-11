# ADR-0051: Product prices leave out receipts filed under the cafe category

> **Status:** proposed
> **Date:** 2026-10-11
> **Related plan(s):** [Plan 0050](../plans/0050-prices-without-cafe-receipts.md)

## Context

`/prices` (ADR-0039) folds every receipt item into a product's monthly spend and unit price. The
owner reads it as a check on shop inflation. A cafe or restaurant receipt carries cooked food and
drinks whose names match the catalog (`kafa`, `hleb`, `pivo`, `sok`), at several times the shop
price. One such receipt in a month moves the month's unit price far more than any real price
change does.

Nothing on a receipt row says "cafe". `receipts.seller_name` is a legal or brand name, often with no
telling word. What the bot does know is the expense the receipt belongs to, and that expense's
category. Every ledger gets the preset «Кафе и рестораны» with `preset_key = 'cafe'`
(`src/domain/categoryPresets.ts`), and the category suggestion files cafe receipts there.

## Decision

> A receipt item counts toward product prices only when its expense is not in the ledger's
> category with `preset_key = 'cafe'`, archived or not. The rule covers every path that reads items
> for products: the product list, a product's screen and chart, the review of unmatched names, and
> the coverage report. A sealed row's category comes from its opened payload. A category without a
> preset key, such as a user's «Обеды», counts like any other.

The user corrects a misfiled receipt by changing its expense's category. `/prices` follows on the
next tap, since nothing about products is stored per item (ADR-0041).

## Consequences

### Positive
- No new data, migration or setting. The rule reads a key every ledger already has.
- One correction mechanism the user already knows: the category on the expense card.
- Cafe item names stop crowding the review queue, so the queue holds shop items to match.

### Negative
- A cafe receipt filed under another category still counts, until the user moves it.
- A user who eats out under their own category gets no exclusion. A per-category switch would
  fix that, and is left for later.
- A shop receipt filed under «Кафе и рестораны» (coffee beans bought at a cafe) drops out.

## Alternatives considered

### Alternative A: Seller-name keywords

Match `seller_name` against `restoran`, `kafe`, `bar`, `picerija` and similar. It needs no user
action, but Serbian seller names are often a company or brand with no such word, a miss has no
correction path short of a per-shop override, and every new keyword is a guess.

### Alternative B: Only the groceries category counts

The strictest rule, and it drops fuel from a petrol station, a pharmacy and a hardware store from
`/prices`, which are prices the owner also wants to follow.

### Alternative C: A "not for prices" switch on every category

The most flexible, but it adds a column, a button and copy to `/categories` for a case the owner
does not have today. It stays open as a later plan if the preset rule proves too narrow.
