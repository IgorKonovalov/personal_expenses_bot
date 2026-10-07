# ADR-0045: Chart payload v2: deflated JSON in `#z=`, a list of sections the page skips when it doesn't know them

> **Status:** accepted (2026-10-07)
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0041](../plans/done/0041-chart-capacity-and-period-comparison.md) (introduces it),
> [Plan 0042](../plans/done/0042-chart-pace-and-budget-burn-down.md),
> [Plan 0043](../plans/0043-chart-category-detail.md),
> [Plan 0044](../plans/0044-charts-for-tags-and-prices.md) (add sections)

## Context

ADR-0025 sends a chart's data in the button URL's fragment as `#d=<base64url JSON>`. Plan 0030
caps the `d` value at `CHART_PAYLOAD_BUDGET` = 2048 characters. Nobody has measured the real
limit yet: Plan 0030 Phase 2 is still owed, and nothing so far shows that a 2048-character
fragment opens. A typical month comes to about 1.2 KB: twelve categories and six trend bars.

The planned views need several times more data. A comparison with the previous period needs a
previous amount and a delta label for each category. A daily pace line needs up to 31 points per
period, for two periods. A per-category trend needs 6 amounts and labels for each category.
Together that is roughly 3–5 KB of base64. Most of those bytes are labels the bot formats, and
JSON and base64 inflate them further: each Cyrillic letter is 2 UTF-8 bytes, and base64 adds a
third on top.

The page is a static `tsc` build with no runtime dependencies, under a CSP of `default-src 'none'`
(ADR-0025). Modern webviews ship `DecompressionStream('deflate')`: Chromium 80+, which covers
Android and Telegram Desktop, and Safari 16.4+, which is iOS's `WKWebView`. Node's `zlib`
produces the same format on the bot side. Plan 0030 also hard-wired one layout, a pie and then a
trend. The planned views add more layouts: a pace line, a budget burn-down, a tag pie and
product price bars.

The page is published from `pages.yml` and the bot from `deploy.yml`. Both run on a push to
`main` but finish at different times, and old chart buttons stay in chats for months. The page
and the bot can be a version apart in either direction.

## Decision

> The bot sends chart payloads as version 2: `#z=<base64url(deflate(UTF-8 JSON))>`, using zlib
> deflate (the `deflate` format of `DecompressionStream`, not `deflate-raw`). The page keeps
> decoding version 1 `#d=` so that old buttons still open. A v2 payload is
> `{ v: 2, title, sections: Section[] }`. The page draws the sections in order. A section whose
> `k` it doesn't know is **skipped silently, and the rest are still drawn**. A known section with
> a malformed body makes the whole payload broken. New sections and new optional fields are
> additive and never bump `v`. Only a change that an old page would misdraw bumps it. The budget
> applies to the `z` value's length after compression. When the payload is over budget, the
> encoder sheds detail in an order each section declares: optional sections first, the pie's
> folding last. `CHART_PAYLOAD_BUDGET` stays 2048 until a probe on real clients has measured the
> limit (Plan 0041). After that it may rise to half the smallest size that opened on every client
> tried. Every label is still formatted by the bot's messages module. ADR-0025's rule that the
> page does no money formatting or arithmetic stands.

## Consequences

### Positive
- Formatted labels, the repeated Cyrillic names and JSON punctuation all compress well. The same
  2048 characters carry several times more data, with no new dependency on either side.
- The page stays the single renderer of a few section kinds (pie, bars, line). A new chart entry
  point (`/budget`, a tag report, `/prices`) composes existing sections or adds one, and needs no
  new page mode.
- Version skew is harmless in both directions. An old page ignores a new section, and a new page
  draws an old `#d=` button.

### Negative
- **Clients older than Safari 16.4 or Chromium 80 can't open a v2 chart.** They show the
  `chartUnsupported` line, and the text report still works. Plan 0041's live check tries the clients
  the user actually has. We know of no old-iOS user, and that is unverified.
- **Decoding is asynchronous.** The page draws after a promise resolves, so the page code and the
  tests await. A slow device shows an empty page for a moment.
- **The budget is no longer predictable from the input.** How well a payload compresses depends on
  its content, so the encoder compresses again on each shedding step. Each step is a
  `deflateSync` of a few KB, which is negligible next to the six summary reads a chart already
  costs.
- **The page skips unknown sections silently.** A bot bug that emits a misspelled `k` shows a
  chart that's missing a section, with no error. Mitigation: the bot-side round-trip tests decode
  through the page's decoder and assert each emitted section kind is one the page draws.
- Two envelope versions live in the page until no v1 button is worth opening. Removing v1 is a
  later decision, not part of this one.

## Alternatives considered

### Alternative A: Compact v2 without compression; the page formats amounts
The payload drops the bot's labels and sends a format spec instead: exponent, group separator,
currency suffix and the `≈` marker. The page then formats the integers itself. It works in every
webview and roughly halves the size. It lost because money formatting would live in two codebases
that share no code, which reverses the part of ADR-0025 that keeps the page out of money. A parity
test can catch drift but can't prevent it, and every new label kind (percent, delta, unit price)
would need its formatter written twice.

### Alternative B: Measure the limit and only raise the budget
Probe the limit and raise `CHART_PAYLOAD_BUDGET` to it, keeping `#d=` v1. That's no code at all.
It lost because it bets everything on a measurement we don't have yet. If clients cap the
fragment near 2–4 KB, the comparison, pace and category-trend views don't fit. And a wider budget
still leaves the pie-and-trend layout hard-wired. The probe still happens (Plan 0041 Phase 3), and
it can raise the budget on top of compression.

### Alternative C: One button per view, each with its own small payload
`/month` gets «📈 Структура», «📈 Темп» and «📈 Тренд», each under 2048 characters. It lost because
it adds keyboard rows to a screen that already has three, and the page couldn't cross-link the
views. For example, tapping a category to see its trend (Plan 0043) needs both views in one
payload.
