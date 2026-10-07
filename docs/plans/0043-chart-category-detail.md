# 0043: Category detail in the chart: tap a category, see its last six periods

> **Status:** draft
> **Created:** 2026-10-07
> **Depends on:** [Plan 0040](0040-chart-polish.md) (tap selection) and [Plan 0041](0041-chart-capacity-and-period-comparison.md) (payload v2), both merged on `main` first. Run after [Plan 0042](0042-chart-pace-and-budget-burn-down.md) if it is queued, since both extend the shedding order.
> **Related ADRs:** [ADR-0045](../adrs/0045-chart-payload-v2-deflated-sections.md) (payload v2: deflated sections)

## TL;DR

Tapping a category in the `/week` or `/month` chart (Plan 0040's selection) opens a panel right
under its legend row with that category's totals over the shown period and the five before it,
as bars. The data
travels in a new `catTrend` section, built from the six period summaries the chart already reads,
so a render costs no extra database work. The panel stays in the page. It doesn't jump to the
chat, which keeps the drill-down on [По категориям]. The first thing the user sees: `/month`,
«📈 Диаграмма», tap «Кафе», and six bars show Кафе from May to October.

## Context & problem

The trend under the donut is the whole period's total. "Is it the cafés that grew?" means paging
the text screen back month by month and reading one line on each page. Plan 0041's change label
answers that for one step back only.

`periodTrend` (`src/services/periodTrend.ts`) already reads six `ledgerPeriodSummary` results per
render. Each holds the converted lines by category id, and today all but their totals are thrown
away.

## Decision

- **A new v2 section.** `catTrend` carries the six period labels and, per pie line, that
  category's six converted totals with bot-formatted labels. Lines refer to the pie section by
  index, so names don't travel twice.
- **Categories match by id across periods.** The uncategorized line is id `null`. A category
  renamed since keeps its history, under its current name.
- **The page shows the panel on selection, as an accordion.** The panel opens directly under the
  selected legend row, wherever the tap came from, so a tap near the bottom of a long legend
  doesn't open it off-screen above. It reuses `bars.ts`.
- **A line without a series says so.** The fold line «Прочее» and any line whose series was shed
  show `messages.chartNoHistory`: «Истории этой категории здесь нет. Её можно посмотреть в
  /month, листая назад.»
- **The bot names the periods.** The page can't tell weeks from months, so `catTrend` carries the
  panel's caption: «Последние 6 месяцев» or «Последние 6 недель».
- **`catTrend` is shed first.** It's the heaviest and least essential section, so it goes before
  every step in Plans 0041 and 0042. Within it, the series for the smallest lines go first. It is
  always gone before any pie line is folded, so line indices never shift under it.

We rejected a chat jump from the panel (a `/start` deep link into Plan 0037's drill-down): it posts
a visible `/start` message and leaves the page. The user chose to keep the detail in the page.

## Implementation phases

### Phase 1: Walking skeleton: a tapped category shows its six periods
- **Owner skill:** dev
- **What:**
  - `periodTrend` also returns each period's converted category lines.
  - `messages.chart` builds the `catTrend` section for every pie line except the fold line. The
    encoder sheds it as described above.
  - The page's selection handler (Plan 0040) inserts the panel right after the selected legend
    row: a heading of the line's name and the section's caption, then the series as bars. It
    removes the panel when the selection clears or moves to another line.
- **Files touched:** `src/services/periodTrend.ts`, `src/services/periodTrend.test.ts`,
  `src/domain/chartPayload.ts`, `src/domain/chartPayload.test.ts`, `src/bot/messages.ts`,
  `src/bot/handlers/summary.ts`, `src/bot/bot.test.ts`, `webapp/src/payload.ts`,
  `webapp/src/payload.test.ts`, `webapp/src/pie.ts`, `webapp/src/bars.ts`,
  `webapp/src/messages.ts`, `README.md` (Mini App: charts).
- **Done when:**
  - Take a month ledger opened on 2026-10-15 in Europe/Belgrade with Кафе spending only in July
    (4000) and October (5000). Кафе's series is `[0, 0, 4000, 0, 0, 5000]` for 2026-05 to 2026-10,
    oldest first.
  - Each category's last value equals its pie line's `amountMinor`, and its second-to-last value
    equals the category's total over the whole previous period, the one the text screen shows
    after paging back. For a past period that is also the amount behind its Plan 0041 change. For
    a running period it isn't, because Plan 0041 compares the same days only. The test asserts
    both cases on a payload with a converted EUR expense.
  - Take a category renamed between September and October: its series carries September's amount
    under the October name.
  - The uncategorized line's series sums the uncategorized expenses of each period.
  - A test counts `ledgerPeriodSummary` calls per `/month` render: still 6.
  - Over budget, the series of the smallest lines go first. Over 200 seeded random cases, the
    lines that keep a series are always the largest ones, a prefix of the lines by amount. When
    any pie line is folded, `catTrend` is absent.
  - In the page's fake DOM, clicking the Кафе legend row inserts, as the node right after that
    `li`, a panel headed «Кафе» and «Последние 6 месяцев» with a bars SVG of 6 rows. Clicking the
    Кафе slice inserts it in the same place. Clicking the row again removes it, and clicking
    another row moves it under that row. Every label arrives through `textContent`.
  - Clicking «Прочее», or a line whose series was shed while larger lines kept theirs, shows
    `messages.chartNoHistory` in the panel and no bars.
  - A payload without `catTrend` (an old bot, or one shed whole) still selects the line and shows
    no panel.

### Phase 2: Live check
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After the merge and the Pages run, open a real `/month` chart on a phone and tap two
  or three categories.
- **Done when:** Each panel's last bar matches the category's amount on the text screen, and its
  previous bar matches the amount after paging back one month.

## Data shapes

```ts
// illustrative: a v2 section (ADR-0045)
interface CatTrendSection {
  k: 'catTrend';
  caption: string; // formatted: «Последние 6 месяцев», «Последние 6 недель»
  periods: string[]; // six period labels, oldest first
  // `line` indexes the pie section's lines; points are oldest first, one per period
  series: [line: number, points: [amountMinor: number, label: string][]][];
}
```

## Risks & open questions

- **Payload size.** Twelve categories by 6 points by a label of about 15 characters is roughly
  2 KB of JSON before compression. With the budget still at 2048 compressed characters, a crowded
  month keeps series only for its largest categories. Plan 0041 Phase 4 may raise the budget. The
  shedding property keeps it correct either way.
- **Money.** Each point is a summary's integer converted total for the category. The page draws
  bars as geometry and shows bot labels.
- **Time.** Periods come from `previous()` in the ledger's timezone, through the same summaries
  the text screen pages with.
- **Privacy.** Still aggregates by category, never individual expenses.

## What this plan does NOT do

- A jump from the chart to the chat (a deep link into the drill-down). The user ruled it out, and
  [По категориям] stays the way into a category's expenses.
- History for the categories folded into «Прочее».
- Comparing two categories side by side.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: a tapped category shows its six periods | dev | not started | |
| 2: Live check | human | not started | |

### Notes

### Close triggers

## Followups
