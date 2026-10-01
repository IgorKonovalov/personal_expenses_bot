# ADR-0025: A static Mini App with no backend: data arrives in the URL fragment and leaves by sendData

> **Status:** proposed
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0030](../plans/0030-mini-app-charts-and-qr-scan.md)

## Context

Chat can't draw. `/week` and `/month` (ADR-0011 screens) answer with text lines per category,
and a trend across months doesn't fit in a message at all. A Telegram Mini App can draw on a web
page, and it can open the phone's live QR scanner (`showScanQrPopup`), which makes the receipt
flow (ADR-0018) quicker than taking a photo.

The usual Mini App design is a web page plus an HTTPS API that reads the database and checks the
`initData` signature. That doesn't fit how this bot runs. It long-polls, so it has no HTTP port,
and its health check is a heartbeat file (Plan 0002). It runs in a container capped at 256 MiB
on a VPS shared with sibling bots, and that VPS has no domain, TLS certificate or reverse proxy
for it. An HTTPS page on another host can't call a plain-HTTP API, because browsers block
mixed content. So any API on the VPS needs TLS there.

Two Telegram mechanisms move data without a server. The bot controls the URL of every `web_app`
button it sends, and a browser never sends a URL's `#fragment` to the host. A Mini App opened
from a **reply-keyboard** `web_app` button can call `Telegram.WebApp.sendData()`, which closes
the app and delivers up to 4096 bytes to the bot as a `web_app_data` message over long polling.

## Decision

> The Mini App is a static page hosted on GitHub Pages, with no backend. The bot puts the data a
> chart needs (aggregates only, no individual expenses) into the button URL's fragment, as
> `#d=<base64url JSON>`. The page draws from that payload alone and makes no network requests: a
> CSP of `default-src 'none'` enforces that, and only `telegram-web-app.js` is allowed as a
> script source. Data leaves the page only by `sendData()`, which the bot handles like any other
> message. The payload is a versioned contract. Its type lives in `src/domain/` and the page
> imports it type-only. Amounts travel as integer minor units for geometry plus label strings
> already formatted by the bot's messages module, so the page does no money formatting or
> arithmetic. The bot builds the button only when `WEBAPP_URL` is set.

## Consequences

### Positive
- The VPS doesn't change. There's no port, domain, certificate, proxy or memory cost, and
  idempotency and auth stay where they are, in the update handlers.
- The static host never sees ledger data. It serves the same files to everyone, and the fragment
  stays in the client.
- Scanned QR text arrives as an ordinary update and goes through the same `answerReceipt` path as
  a pasted link. Nothing new is stored.
- It doesn't block a later API. A plan that needs live reads or writes adds one beside this,
  with its own ADR.

### Negative
- **The data in a chart is a snapshot taken when the button was sent.** A chart opened from an
  old message shows that day's numbers. The summary screen rebuilds its button on every render,
  which limits this.
- **The URL length caps the payload.** Telegram documents no limit for `web_app` button URLs.
  Plan 0030 measures one and budgets below it. A long month folds its smallest categories into
  one line, and a trend shows fewer periods.
- **Telegram appends its own launch parameters (`tgWebAppData` and others) to the fragment.** The
  page has to read our `d` key next to them. This is unverified on real clients, and Plan 0030
  Phase 2 is that check.
- `web_app` buttons work only in private chats. Group ledgers (ADR-0014) get no chart button and
  no scan button.
- **The aggregates sit in the button URL inside Telegram's message storage.** That is no more
  than the summary text already puts there. A sealed ledger (ADR-0020) must not put locked data
  in a button.
- The page needs its own build (`webapp/`, plain `tsc` with DOM types and no bundler) and a
  second Pages job in CI. Its few strings of its own, such as the "open this from the bot"
  fallback, live in `webapp/src/messages.ts`: a second messages module, limited to the page.
- Chart geometry (angles, bar heights) uses floating-point ratios of integer minor units. That is
  rendering, not money: no sum, stored value or displayed amount comes from a float.

## Alternatives considered

### Alternative A: An HTTPS API on the VPS with `initData` auth
A `src/web/` adapter serves JSON to the page, and every request checks the `initData` HMAC. It
would support live data, history browsing, editing and the ADR-0020 passphrase. Rejected for now:
it needs a domain, TLS and a reverse proxy on a shared VPS that has none, plus an HTTP listener
in a 256 MiB container, to deliver charts a snapshot already covers. A future plan that needs
live reads or writes reopens this.

### Alternative B: Server-rendered chart images
The bot renders PNG charts and sends them as photos. There's no page and no host. Rejected: it
adds an image-rendering dependency (a canvas or SVG rasteriser, often a native build) to the bot
image, it doesn't give the live QR scanner, and images can't be inspected by tapping.

### Alternative C: Data in the query string or the `startapp` parameter
The query string is sent to the static host and ends up in its logs. `startapp` (direct-link Mini
Apps) is limited to 512 characters of `[A-Za-z0-9_-]`, which is too small for a month of
categories. The fragment avoids both problems.
