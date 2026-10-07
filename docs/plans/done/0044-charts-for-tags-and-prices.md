# 0044: Charts for tag reports and product prices

> **Status:** done (2026-10-07): built as planned, one minor fixed at close, Phase 3 live check owed, v0.34.0
> **Created:** 2026-10-07
> **Depends on:** [Plan 0041](0041-chart-capacity-and-period-comparison.md) (payload v2 and its `pie` section), merged on `main` first
> **Related ADRs:** [ADR-0045](../../adrs/0045-chart-payload-v2-deflated-sections.md) (payload v2: deflated sections),
> [ADR-0029](../../adrs/0029-tags-on-the-expense-row.md) (tags),
> [ADR-0039](../../adrs/0039-products-from-keyword-rules-and-per-user-overrides.md) (products)

## TL;DR

Two more screens get a «📈 Диаграмма» button in private chats. A tag's report (Plan 0012) opens a
donut of the tag's spending by category, reusing the `pie` section. A product's view in `/prices`
(Plan 0036) opens a new `bars` section with the unit price per month, and the monthly spend under
it. Both reuse the page's renderers, so the work is mostly on the bot side. The first thing the
user sees: open the `#отпуск` report, tap «📈 Диаграмма», and a donut splits the trip into
Жильё, Транспорт and Еда.

## Context & problem

The tag report and the product view are text lists, and both answer questions a picture answers
faster. "Where did the trip money go" is a share question, which is the pie's job. "Is milk
getting dearer" is a trend over months, and 12 lines of «Сентябрь 2026: 129.90 RSD/л» hide it.
ADR-0045's sections let a screen compose a chart from parts the page already draws, without a new
page mode.

## Decision

- **Tag report.** The tag report screen (`src/bot/handlers/tags.ts`) builds a v2 payload titled
  with the tag. It has one `pie` section from `TagReport.converted`, plus `unconverted` lines
  formatted as the report formats them. Shares and folding work exactly as for `/month`. There is no
  change label, because a tag has no previous period.
- **Product view.** The product view (`src/bot/handlers/prices.ts`) builds a payload with a new
  `bars` section kind. Each row is a label, an optional amount in minor units (`null` draws no
  bar) and a formatted text. One section holds the unit price per month and another the spend per
  month, both oldest first. Only the month lines in the ledger's default currency are drawn. Lines
  in other currencies are listed as text, never on the same axis. A month with no sized item has a
  `null` price row, labelled «размер не указан» by `messages`, not a zero bar.
- **Captions use the text screen's unit abbreviations**, which need no declension: the price
  section is «Цена за 1 л», «Цена за 1 кг» or «Цена за 1 шт.», and the spend section is «Траты по
  месяцам».
- **Shedding.** The encoder sheds the spend section first, then the oldest price rows.
- **Where the button appears.** Only in a private chat with `WEBAPP_URL` set, and not on a locked
  sealed ledger. As everywhere, `web_app` buttons don't work in groups.

We rejected drawing a unit-price line chart. With months that have no sized purchase, a line would
interpolate prices nobody paid. Bars with an explicit empty row show the gap.

## Implementation phases

### Phase 1: Walking skeleton: a tag report opens a donut
- **Owner skill:** dev
- **What:**
  - The «📈 Диаграмма» `web_app` button on the tag report screen.
  - `messages.tagChart` builds the input from `TagReport`, and `encodeChartPayload` builds a v2
    payload with one `pie` section.
  - The page needs no change unless a test finds one: it already draws `pie`.
- **Files touched:** `src/bot/handlers/tags.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts` (or
  the tags handler's test), `src/domain/chartPayload.ts`, `src/domain/chartPayload.test.ts`,
  `README.md` (Mini App: charts).
- **Done when:**
  - Take a tag report whose converted block is Жильё 600000, Транспорт 250000 and Еда 150000 RSD,
    plus 50.00 KZT with no rate. Its button's payload decodes through the page's decoder to:
    - a title naming the tag
    - a `pie` section with `totalMinor` 1000000 and shares `[60, 25, 15]`
    - one `unconverted` line for the KZT
  - The pie's `totalMinor` equals the report's converted total.
  - A tag report with nothing converted has no button, like an empty period.
  - In a group, without `WEBAPP_URL`, or with a locked ledger, there is no button, and the report
    is byte-identical to today's.

### Phase 2: A product's prices by month
- **Owner skill:** dev
- **What:**
  - Add the `bars` section to `src/domain/chartPayload.ts` and its mirror.
  - The page draws `bars` with `webapp/src/bars.ts`. A `null` row keeps its label and text, and
    draws no bar.
  - The product view screen gets the «📈 Диаграмма» button. Its payload holds the unit-price
    section, then the spend section, from the same `MonthLine`s the text shows.
- **Files touched:** `src/domain/chartPayload.ts`, `src/domain/chartPayload.test.ts`,
  `src/bot/handlers/prices.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`,
  `webapp/src/payload.ts`, `webapp/src/payload.test.ts`, `webapp/src/bars.ts`,
  `webapp/src/main.ts`.
- **Done when:**
  - Take a product (unit l) bought in RSD in July 2026 (2 l for 25980, so 12990 per l), August
    (only an unsized item, 15000) and September (1 l for 13490). The price section's rows are,
    oldest first:
    - `[«Июль 2026», 12990, …]`
    - `[«Август 2026», null, «размер не указан»]`
    - `[«Сентябрь 2026», 13490, …]`

    The spend rows are 25980, 15000 and 13490. The price section's caption is «Цена за 1 л» and
    the spend section's is «Траты по месяцам».
  - Every price row's amount equals that month line's `unitPriceMinor`, and every spend row's
    amount equals its `spentMinor`. The test reads both from the service's `ProductView`.
  - A month line in EUR in a RSD ledger appears as a text line, not a row.
  - Over budget, the spend section goes before any price row. Then the oldest price rows go,
    oldest first.
  - A product with no month in the ledger's currency has no button.
  - In the fake DOM, a `null` row has its label and text nodes and no `rect`.

### Phase 3: Live check
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After the merge and the Pages run, open a real tag chart and a real product chart on
  a phone.
- **Done when:** The tag donut's total matches the report's total. Each product price bar's label
  matches the month's line on the text screen.

## Data shapes

```ts
// illustrative: a v2 section (ADR-0045)
interface BarsSection {
  k: 'bars';
  caption: string; // formatted: «Цена за 1 л», «Траты по месяцам»
  rows: [label: string, amountMinor: number | null, text: string][]; // oldest first
  notes?: string[]; // lines for other currencies, as text
}
```

## Risks & open questions

- **Money.** Unit prices come from `unitPriceMinor` (ADR-0039), the integer per-unit price the text
  shows. The page draws bar lengths as geometry and shows bot text. Currencies never share an
  axis.
- **Privacy.** The product chart carries a product name and monthly sums, no more than its text
  screen already puts in Telegram. It never carries receipt item names beyond the product's.
- **Payload size.** Products with long histories shed their oldest months. The text screen still
  lists them all.

## What this plan does NOT do

- Tag charts over time, such as a tag's spend per month.
- Comparing several products in one chart.
- Charts for debts, recurring expenses or group ledgers.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: a tag report opens a donut | dev | done | 27d3375 |
| 2: A product's prices by month | dev | done | 3358159 |
| 3: Live check | human | owed | |

### Notes

- Phase 1: the Жильё/Транспорт/Еда + 50.00 KZT done-when is tested at the message level
  (`messages.tagChart` from a hand-built report, through `encodeChartPayload` and the page's
  decoder), not through a bot tap: no preset category is named Жильё or Еда. The real-bot tests
  tap a #отпуск report (450 RSD, 12.50 EUR, 50 KZT) and decode its button.
- Phase 1: `src/domain/chartPayload.ts` and its test are unchanged; a `ChartInput` with no
  pace, trend or catTrend already encodes one pie section.
- Phase 1: the group case is a bot test of `src/bot/group/tags.ts`, which is unchanged.
- Phase 2: the page's section dispatch lives in `webapp/src/pie.ts` (`drawState`), not
  `webapp/src/main.ts`: the `bars` branch went into `pie.ts`, outside `Files touched`, and
  `main.ts` is unchanged.
- Phase 2: the encoder is a separate `encodeBarsPayload` (sections `primary`, `secondary`), not a
  mode of `encodeChartPayload`. It keeps the last price row: one row over budget is undefined.
- Phase 2: the other-currency month lines ride as `notes` on the price section, so they stay when
  the spend section is shed. They are never shed.
- Phase 2: a bars row draws its label at x 0 and its text ending at the right edge, two `text`
  nodes, where a trend row is one «label · amount» node.
- Followup, not acted on: `README.md` (Mini App: charts) names the tag chart but not the product
  chart. Phase 2's `Files touched` holds no `README.md`.

### Close triggers

- Phases 1 and 2 (`dev`) are done in 27d3375 and 3358159. Phase 3 (`human`) has not started. It
  does not block the merge.
- Gate on the tip (3358159):
  - `pnpm typecheck` exited 0.
  - `pnpm lint` exited 0.
  - `pnpm test` exited 0, with 141 files and 2017 tests passed.
  - `pnpm build` exited 0.
  - `pnpm build:webapp` exited 0.
  - `node scripts/check-doc-links.mjs` exited 0, with 335 relative links resolving.
- `CHART_PAYLOAD_BUDGET` is still 2048 and `CHART_PAYLOAD_VERSION` is still 2.
- No new file. No migration, dependency or `webapp/index.html` change.
- New exports: `BarsSection` and `BarsRow` (bot and page), `BarsInput` and `encodeBarsPayload`
  (bot), `drawBars` (page).
- New messages: `tagChart`, `productChart`, `chartPriceUnsized`.

## Close review

Closed 2026-10-07 on review round 1 (tip 4b330fa). Minor 1 is fixed at close in a5d05a0 (the
README lists the product chart). Phase 3 (`human`, the live phone check) stays owed. No earlier
round raised a finding.

### Plan 0044 review, round 1 (tip 4b330fa)

**Verdict:** Clean. Both `dev` phases do what the plan asked, the assertions match their done-whens, and the gate is green. The one open finding is minor: the README's chart list doesn't mention the product chart. The plan can close once the close session decides whether to fix that or file it as a followup.

#### Gate (run in this session on the tip)

- `pnpm typecheck`: exit 0 (both `tsc` projects, bot and webapp).
- `pnpm lint`: exit 0.
- `pnpm test`: exit 0. 141 files and 2017 tests passed.
- `node scripts/check-doc-links.mjs`: exit 0. 335 relative links resolve.

#### Lens 1: alignment

- **Phases:** 1 and 2 are done in 27d3375 and 3358159. Phase 3 (`human`, `Blocks merge: no`) is owed after the merge and the Pages run. Each phase has one owner tag from the allowed set.
- **Deviations the log discloses**, all checked against the tree:
  - The page's section dispatch went into `webapp/src/pie.ts` (`drawState`), not `main.ts`.
  - The encoder is a separate `encodeBarsPayload` function.
  - `chartPayload.ts` and its test are unchanged in Phase 1.
  - The other-currency lines ride as `notes` on the price section.

  None of these goes against the plan's intent.
- **Phase 1 done-whens:**
  - `src/bot/bot.test.ts:9090` asserts the full decoded payload from a hand-built report, through `messages.tagChart`, `encodeChartPayload` and the page's `decodeChartPayload`:
    - the title `#отпуск`
    - `totalMinor` 1000000
    - shares `60%/25%/15%`
    - one `unconverted` line, «Без курса НБС: 50.00 KZT»
    - `pie.totalMinor === converted.totalMinor`
  - A real-bot tap then decodes 191404, which matches the text's `≈ 1 914.04 RSD`.
  - Nothing converted: the keyboard is the back row alone.
  - Without `WEBAPP_URL`: the whole `editMessageText` call equals the expected one, with the text identical and only the back row.
  - Locked: the only call is the locked toast.
  - Group: no `web_app` anywhere in the calls. `src/bot/group/tags.ts` is untouched by the diff, so the group report is unchanged.
- **Phase 2 done-whens:**
  - `bot.test.ts:9834` uses the plan's milk fixture: July 2 l for 25980, August unsized for 15000, September 1 l for 13490, plus June in EUR. It asserts:
    - the price rows `[Июль 2026, 12990]`, `[Август 2026, null, «размер не указан»]` and `[Сентябрь 2026, 13490]`
    - the spend rows 25980, 15000 and 13490
    - the captions «Цена за 1 л» and «Траты по месяцам»
    - the EUR month as a note, not a row
  - The test cross-checks every amount against `ledgerProduct(...)` (`unitPriceMinor ?? null` and `spentMinor`), as the plan asked.
  - Shedding: `src/domain/chartPayload.test.ts:767` shows the spend section goes first at `full - 1`, then the price rows go oldest first, one at a time, down to a single row, then the result is undefined.
  - No month in the ledger currency: no `web_app`.
  - Fake DOM: `webapp/src/payload.test.ts:998` shows the null row's slot (y 30 to 60) holds exactly two `text` nodes and no `rect`. The bar widths are proportional (308.14 / 320).
- **ADRs:** none reversed. Payload v2, the 2048 budget and `CHART_PAYLOAD_VERSION` 2 are unchanged (ADR-0045).
- **The log** is shorter than the phases section. Its close triggers match the tree.

#### Lens 2: layering

- grammY is imported only in `src/bot/`.
- `encodeBarsPayload` and `BarsSection` live in the domain with no I/O.
- All copy is in `messages`: `tagChart`, `productChart` and `chartPriceUnsized`.
- Each handler only gates and calls the encoder.
- The tag report and the product view each have one render path, and both carry the chart URL (`tags.ts:165`, `prices.ts:210`).

#### Lens 3: correctness

- **Money:**
  - Rows carry integer `unitPriceMinor` and `spentMinor`.
  - The page validates `Number.isSafeInteger` or `null`.
  - Floats on the page are bar geometry only, and the text shown is the bot's.
  - The price and spend rows are filtered to `product.ledger.defaultCurrency` and formatted in that same currency. Other currencies never reach an axis.
- **Telegram limits:** the URL is capped by the existing payload budget, and the encoder returns undefined when nothing fits (no button).
- **Privacy:** the payloads carry only what the text screens already show. The tests use synthetic fixtures.
- **Locked ledgers:** the product view's locked tap answers with the toast before `chartUrlOf` runs (`prices.ts:200`). It is the same for tags.

#### Lens 4: docs

See the minor finding below.

#### Findings

##### blocker
None.

##### major
None.

##### minor

1. **The README's chart list omits the product chart.** (Fixed at close in a5d05a0.)
   - **What:** README.md's "Mini App: charts" section lists every screen with a «📈 Диаграмма» button (`/week`, `/month`, `/budget`, and now the tag report at `README.md:352`), but not the `/prices` product view that Phase 2 added. The `/prices` row in the command table doesn't mention it either, while `/budget`'s row at `README.md:32` does.
   - **Where:** `README.md:352` (the end of the chart list) and the `/prices` row of the command table.
   - **Why it matters:** the button is a change users can see. Lens 4 asks for the README to describe it, and the chart list currently reads as complete. Dev's log records this as a followup that wasn't acted on, because Phase 2's `Files touched` had no `README.md`. That is the plan's omission, not dev's.
   - **Fix:** after the tag bullet, add a bullet along these lines: "A product's view in `/prices`, in a private chat, opens with its own «📈 Диаграмма» row. Its chart is titled with the product, and shows the price per unit by month («Цена за 1 л») as bars, with a month that has no sized item shown as «размер не указан» and no bar, then «Траты по месяцам». Only months in the ledger's currency are drawn; other currencies are text lines under the prices. A product with no month in the ledger's currency, or a locked sealed ledger, gets no button." Optionally add a matching clause to the `/prices` command-table row. The close session can apply this as part of the docs bookkeeping, since no code changes.

##### nit
None.

#### Bookkeeping owed at close

- Fix or file minor 1 (the README product-chart bullet).
- Flip `Status:` to `done` with the date and verdict, then `git mv` the plan to `docs/plans/done/`. Repair the links (`Depends on: done/0041…` becomes a sibling link, and `../adrs/` becomes `../../adrs/`), then run `node scripts/check-doc-links.mjs`.
- No paired ADR to accept.
- Refresh `docs/plans/README.md`: move the row to recently closed and bump the next free number.
- Bump the version: this is a feature plan, so a minor bump to v0.34.0. Add a `CHANGELOG.md` entry and a `versionAnnouncements` entry (ADR-0013) naming both new charts.
- Phase 3 (`human`, the live phone check) stays owed after the merge and the Pages run. It doesn't block the merge.

## Followups
