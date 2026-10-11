# 0050: Product prices without cafe and restaurant receipts

> **Status:** done (2026-10-11): built as planned, one nit fixed at close, Phase 3 live check owed, v0.40.0
> **Created:** 2026-10-11
> **Related ADRs:** [ADR-0051](../../adrs/0051-product-prices-leave-out-cafe-receipts-by-category.md), [ADR-0039](../../adrs/0039-products-from-keyword-rules-and-per-user-overrides.md), [ADR-0041](../../adrs/0041-product-matches-memoized-in-process-not-persisted.md), [ADR-0020](../../adrs/0020-sealed-ledgers-write-open-read-locked.md)

## TL;DR

`/prices` stops counting receipt items from cafes and restaurants. An item counts only when its
expense is not in the ledger's «Кафе и рестораны» category (`preset_key = 'cafe'`). The first thing
the owner sees: a month's «Молоко» price on `/prices` no longer jumps when a cafe receipt lands in
it, and «cappuccino» no longer waits in the review of unmatched names.

## Context & problem

`/prices` is the owner's shop inflation check (Plan 0036). Cafe receipts carry cooked food and
drinks whose names match the catalog at several times the shop price, so one cafe visit distorts
a month's unit price. They also fill the review queue with dishes nobody wants matched. The
2026-10-11 coverage report showed cafe items such as prepared salads and coffee among the unmatched
names.

## Decision

Leave out every item whose expense's category carries `preset_key = 'cafe'`, archived or not, on
every path that reads items for products (ADR-0051). The rule lives in one place in
`src/services/productPrices.ts`, applied to the plaintext rows and to the opened sealed rows
alike. The coverage tool applies the same predicate. We rejected seller-name keywords because they
guess with no correction path, groceries-only because it drops fuel and pharmacy prices, and a
per-category switch because it adds a migration and UI for a case the owner does not have.

## Architecture diagram

```mermaid
flowchart LR
    subgraph db
        RI[listLedgerDatedItems<br/>+ categoryId]
        CI[listCategoryIdsByPreset<br/>archived included]
    end
    subgraph services
        OI[productPrices.ownItems]
        SE[sealed rows:<br/>opened payload categoryId]
    end
    subgraph domain
        P[excludedFromPrices<br/>presetKey === 'cafe']
    end
    RI --> OI
    SE --> OI
    CI --> OI
    P --> CI
    OI --> L[list / product / chart / review]
    OI -.same predicate.-> T[tools/productsCoverage]
```

## Implementation phases

### Phase 1: Cafe receipts leave /prices

- **Owner skill:** dev
- **What:** `listLedgerDatedItems` also returns each item's expense `categoryId`. A new
  `listCategoryIdsByPreset(db, ledgerId, presetKey)` in `src/db/categories.ts` returns the ids of a
  ledger's categories with that preset key, archived ones included (as `listEssentialCategoryIds`
  does). The preset key that keeps items out of prices is a named constant beside the presets in
  `src/domain/categoryPresets.ts`. `ownItems` in `src/services/productPrices.ts` drops every
  plaintext item and every opened sealed item whose category is in that set; for a sealed row the
  category is the opened payload's `categoryId`, read in the same open that yields the receipt
  (extend `foldedReceiptOf` or add a sibling in `src/services/ledgerKeys.ts`, so a row is opened
  once). Since every screen goes through `resolveItems`, the product list, a product's screen and
  chart, and `unmatchedNames` all follow. No bot-layer file changes.
- **Files touched:** `src/db/receiptItems.ts`, `src/db/receiptItems.test.ts`,
  `src/db/categories.ts`, `src/db/categories.test.ts`, `src/domain/categoryPresets.ts`,
  `src/services/productPrices.ts`, `src/services/productPrices.test.ts`,
  `src/services/ledgerKeys.ts`, `src/services/productReview.test.ts`.
- **Done when:** service tests on a personal ledger with default currency RSD, the viewer's
  receipts in September 2026:
  - A receipt under «Продукты» with `MLEKO 1L`, quantity 1, 150.00 RSD, and a receipt under «Кафе и
    рестораны» with `MLEKO 1L`, quantity 1, 400.00 RSD: «Молоко»'s September line reads spent
    15000 minor and unit price 15000 minor per litre, not 55000 and 27500.
  - Moving the cafe expense to «Продукты» and reading again gives spent 55000 and unit price 27500
    minor per litre (55000 over 2 l), with no restart: nothing is cached per item.
  - A cafe receipt item `CAPPUCCINO` is not in `unmatchedNames`; the same name on a «Продукты»
    receipt is.
  - Archiving «Кафе и рестораны» keeps its expenses' items out.
  - A receipt under a user-created «Обеды» (no preset key) counts.
  - An unlocked sealed ledger with the same two receipts gives the same 15000 / 15000 figures.
  - A group ledger leaves its own cafe category's items out, and the viewer still sees only their
    own items (unchanged).

### Phase 2: The coverage report and the guide follow

- **Owner skill:** dev
- **What:** `src/tools/productsCoverage.ts` leaves the same items out of its counts, and prints one
  line per ledger with how many items and how much spend it left out as cafe. The guide's `/prices`
  section in `site/src/content/docs/guide/receipts.mdx` gains one sentence: receipts filed under
  «Кафе и рестораны» don't count toward prices, and moving a receipt to another category brings it
  back.
- **Files touched:** `src/tools/productsCoverage.ts`, `src/tools/productsCoverage.test.ts`,
  `site/src/content/docs/guide/receipts.mdx`.
- **Done when:** a coverage test with one «Продукты» item matched and one cafe item unmatched
  reports items 1, matched 1 (100.0%), and a separate line «cafe: 1 item» with its spend; the
  cafe item is not in the unmatched list. `pnpm docs:check` exits 0.

### Phase 3: Live check

- **Owner skill:** human
- **Blocks merge:** no
- **What:** After the deploy, open `/prices` and the review. Move one cafe receipt you know
  matched a product (coffee, beer, bread) to «Продукты» and back.
- **Files touched:** none.
- **Done when:** with the receipt under «Кафе и рестораны» its item is absent from that product's
  month; under «Продукты» it is present; the review lists no cafe dishes.

## Data shapes

```ts
// illustrative: src/domain/categoryPresets.ts
export const PRICES_EXCLUDED_PRESET: PresetKey = 'cafe';

// illustrative: src/db/receiptItems.ts
export interface DatedReceiptItem extends FetchedItem {
  readonly occurredOn: LocalDate;
  readonly currency: CurrencyCode;
  readonly createdBy: UserId;
  readonly categoryId: CategoryId | null; // new
}
```

No migration, no callback data, no new copy in the messages module.

## Risks & open questions

- **Sealed rows open twice** if the category is read in a second `open` call. Phase 1 reads it in
  the same open as the receipt.
- **A ledger created before categories** (`listLedgersWithoutCategories`) has no cafe category, so
  nothing is excluded there. That is correct: nothing is filed as cafe.
- **Privacy:** no amounts or names are logged; the coverage report stays a local, owner-run tool.

## What this plan does NOT do

- A per-category "not for prices" switch (ADR-0051, Alternative C). A later plan if needed.
- Seller-name detection of cafes.
- Any change to [Позиции] (receipt items by category for a period, Plan 0035), which shows
  cafe items as spending, as it should.
- Any bot-layer change: Plan 0049 is in flight on `src/bot/`.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Cafe receipts leave /prices | dev | done | 20c97e5 |
| 2: The coverage report and the guide follow | dev | done | 6efe981 |
| 3: Live check | human | owed | |

### Notes

- Phase 1: the sealed open is a new `foldedReceiptWithCategoryOf` in `src/services/ledgerKeys.ts`
  returning the receipt and the payload's `categoryId`; `foldedReceiptOf` now delegates to it.
- Phase 1: the diagram's `excludedFromPrices` domain predicate is not a function. The domain holds
  the constant `PRICES_EXCLUDED_PRESET`; `ownItems` turns it into the id set via
  `listCategoryIdsByPreset` and filters locally. The coverage tool repeats the constant plus
  `listCategoryIdsByPreset` (it does not call into `productPrices.ts`).
- Phase 1: the done-when's "15000 minor per litre" is asserted as the September month line's
  `[spentMinor, unitPriceMinor]` (`src/services/productPrices.test.ts`, "cafe receipts"); expenses
  are moved between categories with `setExpenseCategory` from `src/db/expenses.ts`.
- Phase 1: the «Обеды» case files a 40000 milk receipt under «Обеды» and asserts 55000 / 27500.
- Phase 2: the cafe line is printed per ledger-and-currency block, as the report already splits a
  ledger by currency; `LedgerCoverage` gains a `cafe: Share` field. The line reads
  `  cafe: 1 item, 400.00 RSD`.
- Phase 2: the done-when's "matched 1 (100.0%)" is the report's existing `rules 1 (100.0%)` label;
  there is no "matched" label.
- Phase 2: `src/tools/productsCoverage.test.ts` moved the eight-item fixture into the first
  describe's `beforeEach` and gained a `receipt()` helper, so the cafe test starts from an empty
  ledger.
- `pnpm docs:chats` was not run: no scenario or bot copy changed.

### Close triggers

- **What shipped:** receipt items whose expense is in a category with preset key `cafe`, archived
  or not, are left out of /prices (list, product screen, chart, review queue) for plaintext and
  unlocked sealed ledgers, group ledgers included; the products coverage report leaves them out of
  its shares and unmatched names and prints a `cafe:` line per ledger and currency; the guide's
  /prices section says so.
- **User-visible surface changed:** /prices figures and its review queue (no copy or keyboard
  change); `site/src/content/docs/guide/receipts.mdx` «Цены продуктов»; `pnpm products:coverage`
  output.
- **Gate at the tip:** `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0, 154 files,
  2339 tests; `pnpm build` exit 0; `pnpm docs:check` exit 0; `node scripts/check-doc-links.mjs`
  exit 0, 363 links.
- **Outstanding `human` phases:** Phase 3 (live check), `Blocks merge: no`.

## Close review

Round 1, at tip bfbf0a9, by a fresh conductor review session.

**Verdict:** clean. Both dev phases do what the plan contracts, each done-when has a test that
discriminates, and the gate is green. One nit, nothing that blocks the close.

### Gate (run in the review session, at the tip)

- `pnpm typecheck`: exit 0
- `pnpm lint`: exit 0
- `pnpm test`: exit 0, 154 files, 2339 tests
- `pnpm docs:check`: exit 0
- `node scripts/check-doc-links.mjs`: exit 0, 363 links
- `git status --short`: empty before and after

### Lens 1: alignment

- Phases 1 and 2 are done in 20c97e5 and 6efe981. Phase 3 is `human` with `Blocks merge: no`, and
  the log marks it owed. Each phase has a single owner tag from the allowed set. Every file the
  plan names was touched, and nothing outside the lists changed except the plan's own log.
- `src/services/productPrices.test.ts` "cafe receipts (ADR-0051)":
  - Groceries 15000 plus cafe 40000 gives the September line `[15000, 15000]`. After
    `setExpenseCategory` moves the cafe expense to groceries, the same read gives
    `[55000, 27500]`. This matches the done-when arithmetic (55000 / 2 l).
  - Archiving the cafe category keeps the line at `[15000, 15000]`.
  - A user-created «Обеды» (`presetKey: null`) counts: `[55000, 27500]`.
  - After sealing and unlocking, the line is `[15000, 15000]`. `listLedgerDatedItems` filters
    `e.sealed IS NULL` (`src/db/receiptItems.ts:140`), so this figure can only come from the sealed
    path. A missing filter there would give 55000, so the test discriminates.
  - On the group ledger, the other member's groceries receipt for 50000 is excluded, along with the
    viewer's cafe receipt. Result: `[15000, 15000]`.
- `src/services/productReview.test.ts`: a cafe `CAPPUCCINO` gives an empty queue and
  `unmatched === 0`. The same name on a groceries receipt gives `['cappuccino']` and 1.
- `src/db/categories.test.ts`: an archived cafe id is listed, ids are scoped per ledger, and
  another preset key returns `[]`. `src/db/receiptItems.test.ts`: `categoryId` is null, then the
  cafe id after a move.
- `src/tools/productsCoverage.test.ts`: the report shows rules 1 / 15000, unmatched 0,
  `cafe: {items: 1, spentMinor: 40000}`, an empty `topUnmatched`, the text line
  `rules 1 (100.0%)`, the line `  cafe: 1 item, 400.00 RSD`, and no `cappuccino`. The plan's
  done-when says "matched 1 (100.0%)", but the report's existing label is `rules`, and the log
  discloses the difference. This is acceptable.
- Deviations the log discloses:
  - The plan's diagram shows an `excludedFromPrices` domain function. The code uses a domain
    constant `PRICES_EXCLUDED_PRESET` and filters in `ownItems`. This matches the plan's own Data
    shapes and the Decision ("the rule lives in one place in productPrices.ts").
  - The coverage tool repeats the constant and the repository call instead of calling the service.
    Acceptable.
- Sealed rows are opened once: `foldedReceiptWithCategoryOf` returns the receipt and the category
  from one `open`, and `foldedReceiptOf` delegates to it. This addresses the plan's risk.
- ADR-0051 has no silent reversal. Its status is `proposed`, to be accepted at close.

### Lens 2: layering

No grammY import outside `src/bot/`, and no bot-layer file changed. The SQL stays in `src/db/`. The
domain gains only a constant. The plan adds no copy to the messages module.

### Lens 3: correctness

- Money: integer sums of `totalMinor` only, and `formatMoney` for display. No floats.
- Time: unchanged.
- Idempotency: read path only.
- Privacy: nothing is logged. The coverage report prints amounts, but it is the existing local tool
  that only the owner runs.
- Freshness: the excluded id set and each row's category are read on every `ownItems` call, so a
  category move takes effect at once, which the move test confirms.

### Lens 4: docs

`site/src/content/docs/guide/receipts.mdx` gains the sentence the plan asks for. `pnpm docs:check`
is green. No command, env var or config key changed, and `CLAUDE.md` still matches the tree.

### Findings

- **blocker:** none.
- **major:** none.
- **minor:** none.
- **nit 1:** the comment line exceeds the 100-column width at `src/db/receiptItems.ts:119`
  (101 characters). Prettier does not reflow comments, so lint stays green. Fixed at close in
  68451c3 (the three-line comment rewrapped at 100 columns).

### Bookkeeping owed at close (as the review listed it)

- Flip Status to `done` with the date and verdict, `git mv` the plan to `docs/plans/done/`, and
  repair links, then rerun `node scripts/check-doc-links.mjs`.
- Accept ADR-0051 (`proposed` to `accepted`) and refresh `docs/adrs/README.md`.
- Refresh `docs/plans/README.md`: move the row to recently closed and bump the next free number.
- Bump the version. This is a feature plan that changes what /prices shows, so a minor bump fits.
  Update `package.json`, `CHANGELOG.md` and the `versionAnnouncements` entry.
- Phase 3 (human live check) remains owed after the deploy. Record it as outstanding in the close.

### Earlier rounds

None: round 1 was the only review, so no fix round resolved an earlier finding.

### Close

- Done in this close: the plan moved to `done/` with its links repaired, ADR-0051 accepted, both
  indexes refreshed (the plans index already read `0051` as the next free number), and v0.40.0
  (minor: /prices shows different figures) in `package.json`, `CHANGELOG.md` and
  `versionAnnouncements`.
- **Still owed:** Phase 3 (live check, `human`, `Blocks merge: no`), after the deploy.

## Followups
