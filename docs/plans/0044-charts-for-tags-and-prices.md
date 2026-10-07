# 0044: Charts for tag reports and product prices

> **Status:** draft
> **Created:** 2026-10-07
> **Depends on:** [Plan 0041](0041-chart-capacity-and-period-comparison.md) (payload v2 and its `pie` section), merged on `main` first
> **Related ADRs:** [ADR-0045](../adrs/0045-chart-payload-v2-deflated-sections.md) (payload v2: deflated sections),
> [ADR-0029](../adrs/0029-tags-on-the-expense-row.md) (tags),
> [ADR-0039](../adrs/0039-products-from-keyword-rules-and-per-user-overrides.md) (products)

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
| 1: Walking skeleton: a tag report opens a donut | dev | not started | |
| 2: A product's prices by month | dev | not started | |
| 3: Live check | human | not started | |

### Notes

### Close triggers

## Followups
