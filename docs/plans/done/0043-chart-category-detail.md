# 0043: Category detail in the chart: tap a category, see its last six periods

> **Status:** done (2026-10-07): built as planned, one minor and one nit open, Phase 2 live check owed, v0.33.0
> **Created:** 2026-10-07
> **Depends on:** [Plan 0040](0040-chart-polish.md) (tap selection) and [Plan 0041](0041-chart-capacity-and-period-comparison.md) (payload v2), both merged on `main` first. Run after [Plan 0042](0042-chart-pace-and-budget-burn-down.md) if it is queued, since both extend the shedding order.
> **Related ADRs:** [ADR-0045](../../adrs/0045-chart-payload-v2-deflated-sections.md) (payload v2: deflated sections)

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
| 1: Walking skeleton: a tapped category shows its six periods | dev | done | 4c40f26 |
| 2: Live check | human | owed | |

### Notes

- Phase 1: `src/bot/handlers/summary.ts` and `webapp/src/bars.ts` are unchanged. The trend points
  passed to `messages.chart` now carry their lines, and the panel calls `drawTrend` as it is.
- Phase 1: the panel is an `li` that `drawPie` places by rebuilding the legend `ul` through
  `replaceChildren`. `ChartNode` gained no `after`/`remove`, because
  `scripts/probe-webapp-url.test.ts` also implements `ChartNode` and is outside `Files touched`.
- Phase 1: when `messages.chart` builds `catTrend`, no fold line exists yet. The line it skips is
  any pie line named «Прочее» (`CHART_FOLD`), which includes a user category with that name. A
  real fold line only appears after `catTrend` has been shed whole.
- Phase 1: the caption is `Последние ${trend.length} месяцев|недель`. The trend always has 6
  periods.
- Phase 1, done-when "counts `ledgerPeriodSummary` calls per `/month` render: still 6": asserted in
  `src/services/periodTrend.test.ts` on `periodChart`. A past October still reads 6 with the lines
  present. A running period still reads 7, the extra read being the same-days window from Plan 0041.
  The count isn't taken through a bot `/month` render.
- Phase 1: `prettier --check README.md` already failed before this phase (its wide table), and the
  README stays unformatted. The edits are hand-wrapped.

### Close triggers

- Phase 1 (`dev`) is done in 4c40f26. Phase 2 (`human`) has not started. It does not block the
  merge.
- Gate on the tip (4c40f26):
  - `pnpm typecheck` exited 0.
  - `pnpm lint` exited 0.
  - `pnpm test` exited 0, with 141 files and 2003 tests passed.
  - `pnpm build` exited 0.
  - `pnpm build:webapp` exited 0.
  - `node scripts/check-doc-links.mjs` exited 0, with 335 relative links resolving.
- `CHART_PAYLOAD_BUDGET` is still 2048 and `CHART_PAYLOAD_VERSION` is still 2.
- No new file. No migration, dependency or `webapp/index.html` change.
- New exports: `CatTrendSection` and `CatTrendPoint` (bot and page).
- `TrendPoint` gained `lines`.
- New page message: `chartNoHistory`.

## Close review

The round 1 review (tip e3a3e74), in full. No earlier round raised a finding that a fix round
resolved. Phase 2 (`human` live check) stays owed. The minor and the nit below stay open.

### Plan 0043 review, round 1 (tip e3a3e74)

**Verdict:** Phase 1 delivers the plan. There are no blockers or majors. One minor: a user's own
category named «Прочее» loses its history panel. One nit.

#### Gate (run in this session on e3a3e74)

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`: exit 0, with 141 files and 2003 tests passed.
- `node scripts/check-doc-links.mjs`: exit 0, with 335 relative links resolving.

#### Alignment

- Phase 1 (`dev`) is in 4c40f26. Phase 2 (`human`, `Blocks merge: no`) is owed after the merge, as
  the log says. Each phase has one in-vocabulary owner tag.
- I read every done-when's test assertion:
  - The Кафе series `[0, 0, 4000, 0, 0, 5000]` from May to October is asserted in
    `src/bot/bot.test.ts` («gives Кафе ...»), along with the caption and period names.
  - Last point against the whole previous period, with a converted EUR expense, has a test for each
    case. Running October: the last two values are `[99127, 146874]`, the text screen paged to
    September shows `991.27`, and the change is `↑145%` (the same-days window). Past October:
    the pie line is `146874`, the last two values are `[99127, 146874]`, and the change is `↑48%`.
  - Rename: the September amount sits under «Кофейни». Uncategorized: `[0, 0, 0, 1000, 2500, 700]`.
  - Read count: `src/services/periodTrend.test.ts` asserts 6 `ledgerPeriodSummary` calls on a
    past period with the lines present. See the nit.
  - Shedding: the 200-case property in `src/domain/chartPayload.test.ts` asserts the smallest
    kept line's amount is at least the largest shed one's, that kept series are unchanged, and
    that `catTrend` is absent whenever pie lines changed (folded). It also checks that both
    regimes are reached more than 20 times each. A separate test checks that the smallest line's
    series goes before any change label.
  - Page: `webapp/src/payload.test.ts` checks that the panel is the node right after the row
    (from the row and from the slice), its `h2`, `p`, `svg` with 6 `rect`, the bar texts, a close
    on the second tap, a move to another row, `chartNoHistory` for «Прочее» and for a shed line, no
    panel without `catTrend`, markup-like labels as text only, and shape rejection.
- The ADR-0045 shedding rule ("optional sections first") holds. No ADR is reversed.
- The log is shorter than the phases and discloses its deviations: `summary.ts` and `bars.ts`
  are untouched, and the fold-name skip is described.

#### Layering, correctness, docs

- `grammy` is used only in `src/bot`. Copy lives in `messages.ts` and `webapp/src/messages.ts`.
  Amounts are integer minor units taken from the summaries. No float math was added. Periods come
  from `previous()` through `ledgerPeriodSummary` in the ledger's timezone. No logging or
  `callback_data` was added.
- The line indices hold. `messages.chart` builds pie lines and series from the same
  `converted.lines` order. The encoder yields every catTrend step before any fold step, and the
  `bare` input drops `catTrend`.
- The README "Mini App: charts" section covers the panel and the new shedding order. No command,
  env var or `/help` change is owed.

#### Findings

##### blocker

None.

##### major

None.

##### minor

1. **A user category named «Прочее» never gets a history.**
   - **Where:** `src/bot/messages.ts:311` (`if ((line.name ?? UNCATEGORIZED) === CHART_FOLD) return [];`).
   - **What:** `chartCatTrend` skips any pie line named «Прочее». The skip runs before
     `encodeChartPayload` sheds or folds anything, so the real fold line can't exist there yet.
     The log confirms this. The check therefore never matches the fold line it targets. It only
     matches a category the user created or renamed to «Прочее», which is a common Russian
     category name. The preset is «Другое», so presets are not hit.
   - **Why it matters:** Tapping that category shows «Истории этой категории здесь нет», which is
     false. The payload had room for the history and the bot dropped it. The plan says "every pie
     line except the fold line".
   - **Fix:** Delete the name check at line 311. The page already shows `chartNoHistory` for any
     line without a series, and a real fold line never has one, because `catTrend` is shed whole
     before the first fold. If `CHART_FOLD` is then used only by `chartFold`, inline it back.
     Update the `chartCatTrend` comment ("each pie line but one named like the fold line").
   - **Test:** In `src/bot/bot.test.ts` «the category history (catTrend)», rename a category to
     «Прочее» and add spending in two months. Assert that `byName.get('Прочее')?.amounts` carries
     both amounts.

##### nit

1. **The read-count done-when reads 6 only for a past period.**
   - **Where:** `src/services/periodTrend.test.ts` («carries each period's converted lines by
     category id, still from 6 reads»).
   - **What:** The plan says "per `/month` render: still 6". A running `/month` render already made
     more reads before this plan: the screen's own summary, the Plan 0041 same-days window (7 in
     `periodChart`) and `periodPace`. The test counts at the `periodChart` level on a past period.
     That defends the claim that matters, no extra reads for the histories, because
     `messages.chart` is pure. The log discloses this.
   - **Fix:** None owed in code. A future plan should phrase such a count as "unchanged by this
     plan" rather than a number.

#### Bookkeeping owed (at close)

- Phase 2 (human live check) stays owed after the merge. It doesn't block the close.
- Flip the plan to `done`, `git mv` it to `docs/plans/done/`, and repair links. `../adrs/` becomes
  `../../adrs/`, and the plan's `done/` links lose their `done/` prefix. Run
  `node scripts/check-doc-links.mjs`.
- No paired ADR to accept.
- Refresh `docs/plans/README.md` (recently closed row, next free number).
- Minor version bump (a feature plan): `package.json`, `CHANGELOG.md`, and the
  `versionAnnouncements` entry in `src/bot/messages.ts` (ADR-0013).

## Followups
