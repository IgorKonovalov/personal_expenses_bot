# ADR-0053: In-chat widgets: fixed programs in the repo, numbers in `chatData`, drill-down by widget query

> **Status:** proposed
> **Date:** 2026-11-12
> **Related plan(s):** [Plan 0052](../plans/0052-in-chat-chart-widgets.md)

## Context

Bot API 10.4 (2026-11-09) adds widgets: a bot sends a message carrying an HTML/CSS/JS program,
and Telegram runs it in a QuickJS sandbox inside the message bubble, without a WebView. The guide
is at `https://core.telegram.org/bots/widgets`. A widget can draw (inline SVG, canvas 2D, flexbox
and grid). It can also ask the bot for data: `TelegramWidget.request(data)` sends 1 to 64 bytes,
the bot receives a `widget_query` update over the long polling it already runs, and
`answerWidgetQuery` returns up to 1024 bytes to the widget that asked. In production, widgets work
only in private chats with the bot.

ADR-0025 put the charts in a static Mini App because live reads would need an HTTPS API, and with
it a domain, TLS and a reverse proxy on a VPS that has none of them. Widget queries give a live
read without any of that. Widgets also draw in the chat itself, where today the user has to tap
the chart button and wait for the Mini App to load.

The limits shape the design:

- The program's HTML can be at most 32768 bytes, and at most **4096 bytes after zlib level 9**.
- The per-message `chatData` holds at most **1024 bytes of text**, and the bot sets it.
- A sent widget's HTML never changes. Only `editMessageWidgetData` changes what it shows. Each
  such edit is silent but counts against the bot's sending limits.
- Widgets have no network access, no decompression API, no text input, and no camera or other
  media devices.

The last point keeps two features out of widgets: the receipt scan and the `sendData` flow
(Plan 0032). They stay on the Mini App's reply-keyboard button.

The code and shared state of a widget are treated as public. Sent widgets are protected content
and can't be forwarded.

## Decision

> Each chart kind is one fixed widget program in the repo, written in TypeScript under `widgets/`
> and built into an HTML string the bot embeds. A test fails any program whose built HTML is
> over 4096 bytes after zlib level 9, the size Telegram counts. The bot sends a widget only in
> a private chat, never for a locked ledger (ADR-0020), and only when `WIDGETS` is on. The
> numbers travel as `chatData`: a versioned, positional JSON array of at most 1024 bytes, built in
> `src/domain/`. As in ADR-0025, it carries integer minor units for geometry and labels already
> formatted by the messages module, folded to fit. A tap that needs more data calls
> `request()` with a short token (a period key and a category id). The bot answers with
> `answerWidgetQuery` after it checks that the asking user may read that ledger, exactly as a
> callback is checked. The widget program contains no user-facing copy beyond glyphs. Every
> string arrives in `chatData` or in the answer. A widget is a separate message, sent below a
> text screen when the user taps that screen's chart button. It is never sent on every render,
> and a screen never becomes a widget. The screen stays the anchor (ADR-0011, ADR-0050), and its
> paging and drill-downs keep editing it in place. The Mini App keeps the full charts, opened
> from the widget's own button, and the scan. The widget is the in-chat glance plus drill-down.

Bot API 10.4 is newer than grammY 1.46.0. The four widget calls go through one small wrapper in
the bot layer, `src/bot/widgetApi.ts`.

- **Until a grammY release adds 10.4 types:** the wrapper calls grammY's raw API with local
  types.
- **When such a release appears:** it is exempt from ADR-0001's 7-day `minimumReleaseAge`. The
  exemption is one `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`. It names that exact
  `grammy` version if pnpm accepts a version there, and the package name if it doesn't. The
  version is pinned exactly, and the lockfile is committed as usual. The wrapper switches to the
  typed methods, and its local types are deleted.
- **Once that version is 7 days old:** the entry is removed, so the cooldown covers every later
  `grammy` release again.

This is the only exemption to the cooldown, and it covers this one upgrade.

## Consequences

### Positive
- Charts appear in the chat with no tap and no page load, and on every platform Telegram ships.
- Live drill-down with no HTTPS listener. Auth is Telegram's (`from` can't be forged), and the
  ledger check is the same one callbacks already use.
- A shown widget can be refreshed silently with `editMessageWidgetData`, because its numbers
  aren't baked into its code. This plan doesn't use that, but nothing blocks it.
- The programs are ordinary source files: type-checked, unit-tested, and size-gated by a test
  rather than by review.

### Negative
- **Two chart renderers.** The Mini App (`webapp/`) and the widgets draw some of the same
  charts, and a change in one doesn't reach the other.
- **1024 bytes is tight.** Cyrillic labels take two bytes a character, so a month folds to about
  eight lines. That is fewer than the Mini App's 2048-byte deflated payload (ADR-0045) shows.
- **4096 compressed bytes per program** rules out sharing one generic program across every
  chart kind. There is one program per kind, and each adds to the tree.
- **`chatData` sits in Telegram's message storage,** like the summary text and the chart button's
  fragment already do. That is why a locked ledger never gets one.
- **An untyped call path.** Until grammY ships 10.4 types, the wrapper's local types are the only
  check on the four methods' parameters.
- **A cooldown exemption.** A brand-new `grammy` release goes into the bot image without the
  7-day window that is meant to catch a compromised publish. The exposure is limited to one
  package and one version, from the framework the bot already trusts with its token, and the
  entry is removed once the version is 7 days old. Forgetting to remove it would leave every
  later `grammy` release exempt as well.
- **Each query costs a round trip of up to 15 seconds,** and Telegram allows 5 per user per
  5 seconds. A slow read shows the widget's error state, not an answer.
- **Private chats only.** Group ledgers (ADR-0014) get no widget, as they get no `web_app`
  button.

## Alternatives considered

### Alternative A: The bot generates each widget's HTML with the numbers inline
Code and data would share the 4096-byte compressed budget, which leaves more room for data than
1024 bytes of `chatData`. Rejected because a sent widget's HTML is immutable, so a shown chart
could never be refreshed. It would also make the bot assemble JavaScript by string building,
which is untestable as a program.

### Alternative B: The widget fetches its numbers by a background request when shown
Background requests are allowed in a private chat while the widget is visible, so a widget could
arrive empty and always show live data. Rejected because every view would cost a query and a
spinner, run into the 5-per-5-seconds limit, and show nothing offline or after the 15-second
timeout. It suits drill-down taps, not the first view.

### Alternative C: Keep the 7-day cooldown for the grammY upgrade too
The raw-API wrapper would stay until the typed release clears the cooldown. Rejected by the
owner: the untyped wrapper is the riskier of the two, and a week's delay buys little for a
framework release.

### Alternative D: Move the charts and the scan into widgets and retire the Mini App
This would leave one renderer. Rejected because widgets have no camera, so the scan has to stay
in the Mini App anyway. And the 4 KB program cap can't hold the Mini App's comparison, pace and
trend sections together.

### Alternative E: The screen itself is the widget, or a widget follows every render
A widget message with a caption and a keyboard could be the `/month` screen itself. Rejected:
- a text message can't be edited into a widget, so a ☰ Меню hub tap could no longer draw the
  screen into the tapped message;
- a widget can't page in place into the category or item lists;
- a caption is capped at 1024 characters.

Sending a widget under the screen on every render keeps the screen but adds one message per pager
tap or hub visit. That is the stale-screen clutter the anchor model exists to prevent.
