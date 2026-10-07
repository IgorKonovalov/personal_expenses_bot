# 0041: Chart capacity and the comparison with the previous period

> **Status:** draft
> **Created:** 2026-10-07
> **Depends on:** [Plan 0040](0040-chart-polish.md) merged on `main` first (both edit `webapp/src/pie.ts` and its tests)
> **Related ADRs:** [ADR-0045](../adrs/0045-chart-payload-v2-deflated-sections.md) (payload v2: deflated sections),
> [ADR-0025](../adrs/0025-static-mini-app-fragment-in-senddata-out.md) (static Mini App)

## TL;DR

The chart payload moves to version 2: deflated JSON in `#z=`, made of sections the page draws in
order (ADR-0045). On top of it, the legend gets each category's share of the period and its change
against the previous period. The donut centre shows the total's change. A probe script then
measures how long a button URL real clients actually open, which settles the budget Plan 0030
guessed. A period still running is compared with the same days of the period before, so the 15th
of October doesn't look like a drop against all of September. The first thing the user sees on
15 October: `/month`, «📈 Диаграмма», the legend reads «Еда: 120 000.00 RSD · 78% · ↑100%», and
the centre reads «↑158% к 1–15 сентября».

## Context & problem

The richer chart views planned next don't fit the 2048-character `#d=` budget (ADR-0045,
Context): comparisons, pace lines and category trends. The layout is also hard-wired: the page
always draws a pie and then the trend. Comparing with the previous period is the view most often
wanted, and its data is cheap. The text monthly push (Plan 0026) already computes it with
`periodDeltas` (`src/domain/deltas.ts`).

The URL limit itself was never measured. Plan 0030 Phase 2 is still owed, and it needs padded
test buttons that nothing in the repo can send.

## Decision

- **Envelope (ADR-0045).** The bot's `encodeChartPayload` emits `#z=` with v2
  `{ v: 2, title, sections }`. `pie` and `trend` are its first section kinds. The page decodes
  `z` with `DecompressionStream('deflate')` and keeps decoding v1 `d` for old buttons.
- **Shares and changes come from the bot.** It formats them with its messages module. Shares are
  integer percents by the largest-remainder method, so the pie's shares sum to exactly 100. Each
  change is `changeOf` from `src/domain/deltas.ts`, the same rule as the monthly push. The page
  still does no arithmetic on amounts.
- **A running period is compared with the same days.** While today is inside the shown period,
  the comparison window is the previous period's first *n* days, where *n* is the number of days
  elapsed in the shown one. It is clipped at the previous period's end. A past period is compared
  whole with whole, as the monthly push does. The window is the one place this plan adds a summary
  read: a running period costs 7 reads per render, a past one still 6.
- **The comparison basis is named once, in the donut centre.** The legend rows carry only arrows
  (`↑20%`, `↓25%`, `±0%`, `новое`), so the share and the change don't read as two bare percents.
- **The budget stays 2048, now measured on `z`.** The probe (Phase 3) and its live run (Phase 4)
  may raise it in a followup.

We rejected a compact v2 in which the page formats amounts itself, measuring alone without
compressing, and one button per view (ADR-0045, Alternatives A to C).

## Architecture diagram

```mermaid
flowchart LR
  subgraph Bot[bot adapter]
    S[summary handler]
    M[messages.chart]
  end
  subgraph Core[services + domain]
    PT[periodTrend<br/>6 summaries]
    SH[sharesOf]
    PD[periodDeltas]
    EN[encodeChartPayload v2<br/>deflate + shed to budget]
  end
  subgraph Page[webapp]
    DE[decode z or d]
    SEC[draw sections in order<br/>skip unknown k]
  end
  S --> PT --> M
  SH --> M
  PD --> M
  M --> EN -- "#z=" --> DE --> SEC
```

## Implementation phases

### Phase 1: Walking skeleton: v2 `#z=` with shares in the legend
- **Owner skill:** dev
- **What:**
  - Add `ChartPayloadV2` and the `pie` and `trend` section types to `src/domain/chartPayload.ts`.
  - The encoder emits `z` as zlib `deflateSync` of the UTF-8 JSON, then base64url. Over budget, it
    sheds in order: it drops the oldest trend bars, then the `trend` section, then folds the
    smallest pie lines into «Прочее». That is ADR-0045's "optional sections first, the pie's
    folding last". It compresses again at each step.
  - A new pure `src/domain/shares.ts` exports `sharesOf(amounts)`: integer percents by the
    largest-remainder method, ties going to the earlier line. `messages.chart` puts each share's
    label in the pie line as a fourth element.
  - The page decodes `#z=` asynchronously, draws the known sections in order and skips any
    unknown `k`. It still decodes `#d=` v1 and draws it as Plan 0030 did. The mirrored type lives
    in `webapp/src/payload.ts`.
  - A legend row reads «name: amount · share», joined by the page with « · » from the payload's
    strings: «Еда: 120 000.00 RSD · 78%».
  - A client without `DecompressionStream` shows a new `messages.chartUnsupported` instead of
    `chartBroken`, because reopening the chart can't help there: «Это приложение Telegram не может
    показать диаграмму. Обновите Telegram — а пока все цифры есть в текстовом отчёте.»
  - `messages.chartBroken` stops naming `/week` and `/month`, since Plans 0042 and 0044 add charts
    to other screens: «Не получилось открыть диаграмму. Откройте отчёт в боте заново и нажмите
    «📈 Диаграмма».»
- **Files touched:** `src/domain/chartPayload.ts`, `src/domain/chartPayload.test.ts`,
  `src/domain/shares.ts`, `src/domain/shares.test.ts`, `src/bot/messages.ts`,
  `src/bot/handlers/summary.ts`, `src/bot/bot.test.ts`, `webapp/src/payload.ts`,
  `webapp/src/payload.test.ts`, `webapp/src/main.ts`, `webapp/src/pie.ts`, `webapp/src/bars.ts`,
  `webapp/src/messages.ts`, `README.md` (Mini App: charts).
- **Done when:**
  - `sharesOf([120000, 30000, 5000])` is `[78, 19, 3]`, from floors 77/19/3 with the leftover
    point going to the largest remainder (0.419). `sharesOf([1, 1, 1])` is `[34, 33, 33]`.
    `sharesOf([0, 5])` is `[0, 100]`. A property test over 500 seeded random inputs of
    non-negative safe integers with a positive sum asserts the result sums to exactly 100 and
    each share is within 1 of `floor(100 × a / sum)`.
  - A positive line whose share rounds to 0 gets the label `messages.chartShareTiny` («<1%»), not
    «0%».
  - The encoded `z` for lines Еда 120000, Транспорт 30000 and Кафе 5000 in RSD, plus a 6-bar
    trend, decodes through the page's `decodeChartPayload` to a v2 payload `toEqual` to the input.
    The pie section's `totalMinor` is 155000, the integer sum.
  - The folding property from Plan 0030 holds on `z`, over 200 seeded random cases: encoded
    length ≤ budget, the folded lines' amounts summing exactly to the original `totalMinor`, and
    at most one «Прочее». Trend bars are always dropped before any pie line is folded.
  - A v2 payload with an extra section `{ k: 'nope', x: 1 }` between `pie` and `trend` draws the
    pie and the trend and nothing for `nope`. A v2 payload whose `pie` section has lines not
    summing to its `totalMinor` shows `chartBroken`.
  - A v1 `#d=` payload from Plan 0030's tests still draws the same pie, legend and trend.
  - A `z` value that isn't valid deflate shows `chartBroken` and draws nothing. A client without
    `DecompressionStream` shows `chartUnsupported` and draws nothing.
  - The Еда legend row's text is «Еда: 120 000.00 RSD · 78%».
  - The `/month` button URL in `bot.test.ts` has `#z=` and no `#d=`.

### Phase 2: Comparison with the previous period
- **Owner skill:** dev
- **What:**
  - The pie section gains an optional change label per line, plus a total change label. Both come
    from `periodDeltas` (`src/domain/deltas.ts`) over the comparison window's converted lines.
  - The comparison window: for a past period, the whole previous period, which `periodTrend`
    already reads. For a running period (today between `from` and `to` in the ledger's timezone),
    the previous period from its `from` through `from` + (today − shown `from`) days, clipped at
    its `to`. A clipped window that reaches the previous `to` is the whole previous period. The
    window is a `Period` with the previous period's `kind` and a shorter `to`, read through the
    same `ledgerPeriodSummary`, so its conversion and rounding are the text screen's.
  - Change labels are arrows, from `messages`: `chartChangeUp(p)` «↑20%», `chartChangeDown(p)`
    «↓25%», `chartChangeZero` «±0%», and `chartChangeNew` «новое», the push's word.
  - The legend row reads «name: amount · share · change»: «Еда: 120 000.00 RSD · 78% · ↑20%».
  - The donut centre (Plan 0040) keeps its two lines. The total change goes in the second line in
    place of «Всего», with the basis: «↑11% к сентябрю». The basis is formatted by the bot:
    - a past month: «к сентябрю»
    - a past week: «к неделе 28 сентября – 4 октября»
    - a running period's window: «к 1–15 сентября», «к 28–30 сентября»
    - a running window that covers the whole previous period: as for a past one, «к февралю»
  - Change labels are shed before trend bars: the new first step in the shedding order.
- **Files touched:** `src/domain/chartPayload.ts`, `src/domain/chartPayload.test.ts`,
  `src/services/periodTrend.ts`, `src/services/periodTrend.test.ts`, `src/bot/messages.ts`,
  `src/bot/handlers/summary.ts`, `src/bot/bot.test.ts`, `webapp/src/payload.ts`,
  `webapp/src/payload.test.ts`, `webapp/src/pie.ts`.
- **Done when:**
  - Take a month ledger in Europe/Belgrade. September 2026 has Еда 60000 on 2026-09-10, Еда 40000
    on 2026-09-20 and Транспорт 40000 on 2026-09-20. October has Еда 120000, Транспорт 30000 and
    Кафе 5000 RSD, all dated on or before 2026-10-15.
  - Viewed on 2026-11-03 and paged back to October (a past period), the changes are:
    - Еда, 120000 against 100000: `{ kind: 'change', percent: 20 }`, «↑20%»
    - Транспорт, 30000 against 40000: `{ kind: 'change', percent: -25 }`, «↓25%»
    - Кафе: `{ kind: 'new' }`, «новое»
    - the total, 155000 against 140000: `{ kind: 'change', percent: 11 }` (10.71 rounded half
      away from zero), and the centre's second line is «↑11% к сентябрю»
  - Viewed on 2026-10-15 (running), the window is 2026-09-01 to 2026-09-15:
    - Еда, 120000 against 60000: `percent: 100`, «↑100%»
    - Транспорт, against nothing by 15 September: «новое»
    - Кафе: «новое»
    - the total, 155000 against 60000: `percent: 158` (158.33), and the centre reads
      «↑158% к 1–15 сентября»
  - Viewed on 2026-03-30 on March 2026, the window is clipped to 2026-02-01 to 2026-02-28, the
    whole of February, and the basis reads «к февралю».
  - A week chart viewed on Wednesday 2026-10-07 (the week of 5–11 October) compares with
    2026-09-28 to 2026-09-30, and the basis reads «к 28–30 сентября».
  - A category spent on only in the window and not in the shown period isn't listed, as in the
    text push.
  - When the window had nothing, every line reads «новое», and the centre keeps «Всего» with no
    total change.
  - A test counts `ledgerPeriodSummary` calls per `/month` render: 6 for a past period, 7 for a
    running one.
  - Over budget, change labels go first. A seeded case just over budget keeps every trend bar and
    loses the change labels, and the centre's second line falls back to «Всего».

### Phase 3: The URL-limit probe
- **Owner skill:** dev
- **What:** `scripts/probe-webapp-url.ts` (`pnpm probe:webapp`) reads `BOT_TOKEN`,
  `ADMIN_TELEGRAM_ID` and `WEBAPP_URL` from the environment. It sends the admin one message with
  one `web_app` button per target length: 2048, 4096, 8192, 16384 and 32768. Each button carries
  a valid v2 payload titled «Проба N», whose `z` value is padded to its target by an
  incompressible random string in an unknown section. When Telegram refuses a size, the script
  sends the sizes it accepts and prints the Bot API error for each refused one. The payload
  builder is a pure function, tested apart from the send.
- **Files touched:** `scripts/probe-webapp-url.ts`, `scripts/probe-webapp-url.test.ts`,
  `package.json` (the `probe:webapp` script), `README.md` (how to run the probe).
- **Done when:**
  - For each target N, the builder's `z` value has a length between N − 64 and N. It decodes
    through the page's decoder to a payload titled «Проба N» whose known sections draw a one-line
    pie, so an opened button visibly says which size arrived whole.
  - The script never logs the token or a URL. It prints only sizes and Bot API error
    descriptions.

### Phase 4: Measure on real clients and check v2 opens
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After the merge and the Pages run, run `pnpm probe:webapp` with the production env.
  Open every probe button on each client you use (Android, iOS, Desktop). Then open a real
  `/month` chart on each.
- **Done when:**
  - The Implementation log records, per client, the largest «Проба N» that opened with its title
    shown, and any size the Bot API refused.
  - A real `/month` chart opens on every client tried, with shares and changes. That confirms
    `DecompressionStream` is there.
  - If the smallest working size across clients is at least 4096, a followup records raising
    `CHART_PAYLOAD_BUDGET` to half of it. That's a one-constant fix pass.

## Data shapes

```ts
// illustrative: src/domain/chartPayload.ts, mirrored by webapp/src/payload.ts
interface ChartPayloadV2 {
  v: 2;
  title: string;
  sections: Section[]; // drawn in order; an unknown `k` is skipped
}
type Section = PieSection | TrendSection; // Plans 0042-0044 add more kinds
interface PieSection {
  k: 'pie';
  currency: string;
  totalMinor: number; // integer sum of lines
  totalLabel: string;
  totalChange?: string; // Phase 2, formatted with its basis: «↑11% к сентябрю»
  // change, Phase 2: «↑20%»
  lines: [name: string, amountMinor: number, label: string, share: string, change?: string][];
  unconverted: string[];
}
interface TrendSection {
  k: 'trend';
  bars: [periodLabel: string, totalMinor: number, label: string][];
}
// URL: `${WEBAPP_URL}#z=${base64url(deflate(JSON))}`; old buttons: `#d=` v1
```

## Risks & open questions

- **Old webviews.** Without `DecompressionStream`, a v2 chart shows `chartUnsupported`. Phase 4
  finds out whether that hits any real client. If it does, the fallback is an ADR change (ADR-0045,
  Alternative A), not a shim.
- **Version skew.** Pages and the VPS deploy separately. Until the new page is live, a new bot
  sends `#z=` buttons that the old page reads as "no `d`" and answers with `openFromBot`. The
  window is the gap between the two deploy jobs, minutes. The README's deploy note says the Pages
  run should finish first. Merging the page half ahead of the bot half isn't worth a split here.
- **Money.** Shares are integer percents of integer minor units, computed in the domain and never
  shown as money. Changes come from `changeOf`, which uses BigInt arithmetic and is already
  tested. Every amount the page shows is a bot label.
- **Time.** The previous period comes from `previous()` in the ledger's timezone, through the same
  `ledgerPeriodSummary` that pages the text screen. "Running" and the window's length use today
  in the ledger's effective timezone (`deps.now()`), never the browser's clock. A running window
  holds the previous period's expenses through its last day, recorded at any hour, while the
  shown period counts through today. That is the same day-granular comparison the pace line in
  Plan 0042 draws.
- **Privacy.** Still aggregates only. The probe sends synthetic payloads to the admin and logs no
  token or URL.

## What this plan does NOT do

- Pace lines and the budget chart: Plan 0042.
- A category's own trend on tap: Plan 0043.
- Charts for tags and `/prices`: Plan 0044.
- Removing v1 `#d=` decoding from the page.
- Raising the budget. Phase 4 measures, and a followup changes the constant.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: v2 `#z=` with shares in the legend | dev | not started | |
| 2: Comparison with the previous period | dev | not started | |
| 3: The URL-limit probe | dev | not started | |
| 4: Measure on real clients and check v2 opens | human | not started | |

### Notes

### Close triggers

## Followups
