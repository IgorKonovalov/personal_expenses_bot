# 0040: Chart polish: a donut that fits the screen, tap to inspect, colours that hold in dark theme

> **Status:** draft
> **Created:** 2026-10-07
> **Related ADRs:** [ADR-0025](../adrs/0025-static-mini-app-fragment-in-senddata-out.md) (static Mini App, fragment in)

## TL;DR

This plan improves the Mini App chart using the data the payload already carries, with no change
on the bot side. The pie becomes a donut with the period total in the centre, and it scales to the
screen width. Tapping a slice or a legend row picks out that category and shows its name and
amount in the centre. Slice colours come from a light palette or a dark palette, chosen by the
Telegram theme, and redraw when the theme changes. The trend rows get a layout that can't clip a
long amount. The page title stops reading «Скан чека». The first thing the user sees: `/month`,
then «📈 Диаграмма», then a full-width donut with «45 230.00 RSD» in its centre.

## Context & problem

Plan 0030 shipped a working but bare chart (`webapp/src/pie.ts`, `webapp/src/bars.ts`):

- The pie is a fixed 240 px and the trend is a fixed 320 px, whatever the phone's width.
- Nothing responds to a tap. With eleven categories, matching a small slice to its legend row by
  colour alone is guesswork.
- `PALETTE` is a single list tuned for a white background. Several of its colours, such as
  `#edc948` and `#bab0ac`, nearly vanish on white, and the dark theme was never checked.
- A trend amount is drawn after its bar's end, so a long label runs past the 320-unit viewBox
  (Plan 0030, close review nit 2).
- Chart mode never sets `document.title`, so the header reads «Скан чека» from `index.html`
  (Plan 0030, close review nit 1).

## Decision

The work is all page-side, in `webapp/src/`. The payload contract (`ChartPayloadV1`) and the bot
are unchanged, so this plan can ship before Plan 0041 without coordinating with it. The page keeps
two rules from ADR-0025. Every string it shows comes from the payload or from
`webapp/src/messages.ts`. It does no money arithmetic, and floats stay geometry. The CSP has no
`style-src`, so the page styles only through CSSOM property writes (`element.style.maxWidth = …`)
and SVG presentation attributes (`fill`, `opacity`). It never uses a `style` attribute or a
`<style>` element, which the CSP blocks.

We rejected a charting library such as Chart.js or uPlot. It would be the page's first runtime
dependency, loaded from somewhere the CSP would have to allow. And a static donut, a few bars and
a tap handler are a few dozen lines of SVG.

## Implementation phases

### Phase 1: Walking skeleton: a full-width donut with the total in its centre
- **Owner skill:** dev
- **What:**
  - The pie becomes a donut: annular slices between radius 1 and `DONUT_INNER` = 0.6. Two SVG
    text lines sit in the centre: the payload's `totalLabel`, and under it
    `messages.chartTotalCaption` («Всего»).
  - The donut and trend SVGs scale with the viewport. They keep their viewBox and get
    `width="100%"`, plus a CSSOM `maxWidth` (`360px` for the donut).
  - Chart mode sets `document.title` to `messages.chartTitle` («Диаграмма»). Scan mode keeps
    «Скан чека».
  - Chart mode calls `Telegram.WebApp.expand()` when the client has it.
  - The donut SVG gets `role="img"` and an `aria-label` of the title and the total.
- **Files touched:** `webapp/src/pie.ts`, `webapp/src/bars.ts`, `webapp/src/main.ts`,
  `webapp/src/messages.ts`, `webapp/src/payload.test.ts`, `README.md` (Mini App: charts).
- **Done when:**
  - For lines Еда 120000 and Транспорт 30000 (total 150000), the first slice spans 0° to 288° and
    the second 288° to 360°, both measured clockwise from 12 o'clock. Each is a closed path whose
    outer arc has radius 1 and inner arc radius 0.6. The first slice's outer arc ends at
    `-0.9511 -0.309`, which is (sin 288°, −cos 288°) rounded to 4 places. Both slices' paths
    contain the inner-arc point `-0.5706 -0.1854`: the unrounded point scaled by 0.6, then
    rounded. A test asserts these strings.
  - A single positive line draws a full ring (two concentric circles, or a ring path), not a
    sector.
  - The donut's centre holds exactly two text nodes, the payload's `totalLabel` and «Всего», both
    set through `textContent`.
  - The donut and trend SVGs carry `width="100%"` and a viewBox, and no `style` attribute anywhere
    in the tree. The fake DOM gains `style` and `setAttribute('style')` throws in it, so a test
    catches any use of the attribute.
  - In chart mode `document.title` is «Диаграмма». In scan mode `webapp/src/scan.test.ts` is
    unchanged and passes. `webapp/index.html` is unchanged, so the CSP still holds.
  - The existing fallback and XSS tests (`chartBroken`, `openFromBot`, the
    `<img src=x onerror=alert(1)>` name) still pass unchanged.

### Phase 2: Tap a slice or a legend row to inspect it
- **Owner skill:** dev
- **What:**
  - Each slice and each legend row is tappable. A tap selects that line. The other slices dim to
    `DIMMED_OPACITY` = 0.35, the selected legend row is bolded through a CSSOM `fontWeight` write,
    and the centre shows the line's name and its `label` in place of the total.
  - Tapping the selected line again, or tapping the centre, clears the selection.
  - A selection calls `Telegram.WebApp.HapticFeedback.selectionChanged()` when the client has it.
  - Zero-amount lines have no slice. Their legend row is still tappable, and the centre shows the
    line.
- **Files touched:** `webapp/src/pie.ts`, `webapp/src/main.ts`, `webapp/src/payload.test.ts`.
- **Done when:**
  - In the fake DOM (which gains `addEventListener` and a test-side `click()`), clicking the
    Транспорт legend row sets the Еда slice's `opacity` to `0.35` and the Транспорт slice's to `1`.
    The centre's two text nodes then read «Транспорт» and that line's `label`. Clicking the row
    again restores both slices to `1` and the centre to `totalLabel` and «Всего».
  - Clicking a slice selects the same line its legend row would.
  - A category named `<img src=x onerror=alert(1)>`, once selected, appears in the centre only
    through `textContent`, and the tree still holds no `img` node.
  - No selection state is written to `localStorage` or sent anywhere: the page still makes no
    network request and calls no `sendData`.

### Phase 3: Theme-aware palettes and a trend layout that can't clip
- **Owner skill:** dev
- **What:**
  - A new `webapp/src/palette.ts` holds two categorical palettes of 8 colours, `LIGHT` and
    `DARK`. The page picks one by the relative luminance of `themeParams.bg_color` (dark below
    0.5), defaulting to `LIGHT`.
  - Lines past the eighth draw in the theme's `hint_color`, with the matching legend swatch,
    instead of cycling back to the first colour.
  - The page listens for Telegram's `themeChanged` event and redraws with the new theme.
  - Trend rows change layout. Each row is a text line, «period · amount» from the payload's
    `periodLabel` and `label`, above a bar that can use the full width. No text is positioned
    relative to a bar's end.
  - The shown (last) period's bar uses `themeParams.button_color`, and earlier bars use the same
    colour at 0.5 opacity.
- **Files touched:** `webapp/src/palette.ts`, `webapp/src/palette.test.ts`, `webapp/src/pie.ts`,
  `webapp/src/bars.ts`, `webapp/src/main.ts`, `webapp/src/payload.test.ts`.
- **Done when:**
  - Every `LIGHT` colour has a WCAG contrast ratio of at least 3:1 against `#ffffff`. Every `DARK`
    colour has at least 3:1 against `#212d3b`, the lightest dark background among Telegram's
    default themes as far as we know (unverified across clients). A test computes the ratios and
    asserts both.
  - No two colours within one palette are equal.
  - With `bg_color` `#000000`, slices draw from `DARK`. With `#ffffff` or no theme, they draw
    from `LIGHT`.
  - A payload with 10 lines colours lines 9 and 10 with the theme's `hint_color` (`#999999`
    without a theme), both in the slices and in the legend swatches.
  - A trend row's amount text has the same `x` as its period text, and every text node's `x` is
    `0`. A label as long as «≈ 1 234 567.89 RSD» therefore can't start past the viewBox.
  - The last trend bar's `fill` is the theme's `button_color`, and the others carry
    `opacity="0.5"`.
  - Firing the fake `themeChanged` handler with a new `bg_color` redraws the slices from the other
    palette, with no duplicated nodes under `body`.

### Phase 4: Live check, light and dark
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After the merge and the Pages run, open a real `/month` chart on a phone in a light
  theme, then switch Telegram to a dark theme with the chart open. Open it on Telegram Desktop as
  well if you use it.
- **Done when:**
  - The donut fills the width, and the centre total matches the text screen's total.
  - Tapping a small slice shows its name and amount.
  - Every slice is distinguishable from the background in both themes.
  - No trend amount is cut off.

## Risks & open questions

- **CSP and styling.** `default-src 'none'` with no `style-src` blocks `style` attributes and
  `<style>`. Phase 1's fake DOM throws on `setAttribute('style')` so a regression fails a test
  instead of failing silently on a phone. CSSOM writes are allowed under the CSP, as `main.ts`
  already relies on.
- **Theme colours are client-defined.** `#212d3b` as the worst-case dark background is a guess
  from the default themes. A custom theme can pick any colour. The `hint_color` fallback and the
  slice separators drawn in `bg_color` keep adjacent slices apart whatever the background.
- **Money.** Nothing here formats or adds an amount. Angles and bar lengths are geometry. The
  centre shows the payload's labels as they are.
- **Privacy.** Unchanged. The page reads the fragment and writes only to the DOM.

## What this plan does NOT do

- Percentages, period comparison, and any change to the payload: Plan 0041, which needs
  ADR-0045's capacity.
- A per-category trend on tap: Plan 0043. Phase 2's selection is the hook it builds on.
- A colour that stays fixed per category across periods. Colour follows line order, as today.
- Animations or transitions.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: a full-width donut with the total in its centre | dev | not started | |
| 2: Tap a slice or a legend row to inspect it | dev | not started | |
| 3: Theme-aware palettes and a trend layout that can't clip | dev | not started | |
| 4: Live check, light and dark | human | not started | |

### Notes

### Close triggers

## Followups
