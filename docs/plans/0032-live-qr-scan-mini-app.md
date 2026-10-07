# 0032: A live QR scan in a Mini App records a receipt

> **Status:** in-progress
> **Created:** 2026-10-05
> **Related ADRs:** [ADR-0025](../adrs/0025-static-mini-app-fragment-in-senddata-out.md) (static Mini App, fragment in, sendData out),
> [ADR-0018](../adrs/0018-receipts-record-offline-enrich-async.md) (receipts),
> [ADR-0034](../adrs/0034-qr-retry-on-preprocessed-pixels-jpeg-js.md) (QR retry on photos)

## TL;DR

A «📷 Скан» button on the private-chat menu opens a static Mini App page that immediately opens
Telegram's own live QR scanner (`showScanQrPopup`). The first code it reads goes back to the bot
through `sendData()` and is recorded exactly like a pasted receipt link. This is the Mini App
scaffold and the scan from Plan 0030, split out and built first. Plan 0030 keeps the charts and
builds on this page. The first thing the user sees: tap «📷 Скан», point the phone at a receipt,
and the expense card arrives without taking a photo.

## Context & problem

Receipt photos fail too often. Of 8 real photos that got the hint, the photo path reads 2 after
Plan 0031's retries, and three more have a QR that is located but unreadable at 7 to 8 px per
module (Plan 0031's Implementation log). A single still can't fix blur, glare or angle after the
fact. A live scanner tries frame after frame while the user moves the phone, and sends only the
link text. Plan 0030 had this as its Phase 4, behind three chart phases and last in the conductor
queue.

## Decision

The scan ships alone, run by hand outside the conductor. A `webapp/` directory holds one static
page: `index.html` plus TypeScript compiled by plain `tsc` (DOM lib, no bundler, no runtime
dependencies) to `webapp/dist/`, published to GitHub Pages by a workflow. Opened with `#m=scan`,
the page calls `showScanQrPopup`, closes it on the first text and calls `sendData(text)`. A
`message:web_app_data` handler runs the text through `decodeReceiptUrl` and `answerReceipt`, the
path a pasted link takes. The «📷 Скан» button is a `web_app` reply-keyboard button, because only
a page opened from one can call `sendData` (ADR-0025). It appears only in private chats and only
when `WEBAPP_URL` is set.

We rejected reordering Plan 0030 instead: the scan couldn't close until the charts and their URL
limit measurement were done. No new ADR: ADR-0025 already decides the static page and
`sendData`.

## Architecture diagram

```mermaid
flowchart LR
  subgraph TG[Telegram client]
    U[user]
    P[Mini App page, scan mode<br/>webapp/ on GitHub Pages]
    Q[showScanQrPopup]
  end
  subgraph Bot[bot adapter]
    M[menu keyboard]
    W[web_app_data handler]
  end
  subgraph Core[domain + services]
    D[decodeReceiptUrl]
    R[answerReceipt path]
  end
  M -- "📷 Скан, url#m=scan" --> P --> Q
  Q -- first text --> P
  P -- "sendData(text)" --> W --> D --> R
```

## Implementation phases

### Phase 1: Walking skeleton: «📷 Скан» records a receipt
- **Owner skill:** dev
- **What:** The `webapp/` page in scan mode, its build, the Pages workflow, the optional
  `WEBAPP_URL` config key, the «📷 Скан» menu button, and the `web_app_data` handler. Opened without
  `#m=scan`, or where the client lacks `showScanQrPopup` (Telegram Desktop and web clients),
  the page shows a `webapp/src/messages.ts` line instead and sends nothing.
- **Files touched:** `webapp/index.html`, `webapp/src/main.ts`, `webapp/src/scan.ts`,
  `webapp/src/scan.test.ts`, `webapp/src/messages.ts`, `webapp/tsconfig.json`, `package.json`
  (`build:webapp` script), `vitest.config.ts` (`include` gains `webapp/src/**/*.test.ts`),
  `eslint.config.js` (covers `webapp/`), `.github/workflows/pages.yml`,
  `scripts/pages-workflow.test.mjs`, `src/config.ts`, `src/index.ts` (passes `WEBAPP_URL` into
  `createBot`), `src/bot/testHarness.ts`, `.env.example`, `src/bot/keyboards.ts`,
  `src/bot/handlers/help.ts`, `src/bot/handlers/start.ts`, `src/bot/handlers/menu.ts`,
  `src/bot/handlers/webAppData.ts`, `src/bot/bot.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`, `README.md` (Mini App section, `WEBAPP_URL`), `CLAUDE.md` ("Where things
  live": `webapp/`).
- **Done when:**
  - A `web_app_data` update whose data is `buildRsUrl()` records the same expense, amount and
    currency as sending that URL as text (82912 minor units, RSD, with the existing fixture).
    Sending the same data again answers «Уже записано.» and the expense count stays 1, the
    idempotency of ADR-0018.
  - Data that isn't a receipt URL gets a messages-module reply and records nothing. The handler
    doesn't assume Telegram's 4096-byte cap: a 5000-byte string is treated as not a receipt.
  - The menu keyboard from `/start` and `/help` in a private chat carries a `web_app` button
    labelled from the messages module whose URL is `WEBAPP_URL` with `#m=scan`. With `WEBAPP_URL`
    unset, or in a group chat, the keyboard is identical to today's.
  - `scan.test.ts`, with a stub `Telegram.WebApp`: in scan mode the page calls
    `showScanQrPopup` once; on the first text it closes the popup and calls `sendData` with that
    text exactly, once, even if the scanner reports a second code. Without `#m=scan`, or with
    no `showScanQrPopup` on the stub, it calls neither and shows the fallback line.
  - `webapp/index.html` carries a CSP meta whose `default-src` is `'none'` and whose
    `script-src` lists only `https://telegram.org` and `'self'`. No `connect-src` is allowed.
  - `pnpm build:webapp` emits `webapp/dist/index.html` and `webapp/dist/main.js`.
  - `scripts/pages-workflow.test.mjs` (run by the existing `node --test "scripts/*.test.mjs"` CI
    step) asserts that every `uses:` in `.github/workflows/pages.yml` is pinned to a
    40-character hex SHA, and that the workflow runs `pnpm build:webapp` before uploading
    `webapp/dist`.
  - No log line from the handler contains the scanned text or `suf.purs.gov.rs`.

### Phase 2: Publish and scan a real receipt
- **Owner skill:** human
- **Blocks merge:** no
- **What:** Enable GitHub Pages (source: GitHub Actions), set `WEBAPP_URL` in the VPS `.env`,
  redeploy, send `/help` to get the new menu, then «📷 Скан» real receipts on a phone, starting
  with ones whose photos got the hint.
- **Done when:** The first Pages run on `main` is green and the page is reachable at
  `WEBAPP_URL`. Each scanned receipt shows up as an expense card whose line items arrive later,
  as with a pasted link. The clients tried, and how many of the scanned receipts recorded, go
  into the Implementation log.

## Data shapes

```ts
// illustrative: the page's whole contract with the bot
// in:  WEBAPP_URL + '#m=scan'
// out: Telegram.WebApp.sendData(text) // the scanned QR text, verbatim, <= 4096 bytes
// bot: message.web_app_data.data -> decodeReceiptUrl -> answerReceipt
```

## Risks & open questions

- **Clients without the scanner.** `showScanQrPopup` exists only on mobile clients (unverified
  per client; Phase 2 records which worked). Elsewhere the page says so and the photo and link
  paths remain.
- **Stale menus.** Telegram keeps showing the old persistent keyboard until the next `/start` or
  `/help` reply. Phase 2 sends `/help`. Other users get the button on their next one.
- **Idempotency.** Each scan is a new message, so a double scan of one receipt must be caught by
  the receipt's identity, not the update id. ADR-0018's existing duplicate check does that, and
  Phase 1 asserts it.
- **Privacy.** The scanned text is a receipt URL with the purchase in it. It's never logged, and
  the page makes no network request.
- **Public page.** GitHub Pages needs the repo public, a precondition Plan 0030 already took.
  The page holds no data and no secrets.

## What this plan does NOT do

- Charts. Plan 0030 builds them on this page.
- Scanning non-receipt QR codes into anything but the not-a-receipt reply.
- A BotFather menu button or a "Main Mini App".

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: «📷 Скан» records a receipt | dev | done | 5f85749 |
| 2: Publish and scan a real receipt | human | owed | |

### Notes

- Phase 1: `package.json` `typecheck` also runs `tsc -p webapp/tsconfig.json --noEmit`, since
  the root `tsconfig.json` (not in Files touched) doesn't include `webapp/`. `build:webapp`
  deletes the emitted `*.test.js` from `webapp/dist/`, because one `webapp/tsconfig.json` covers
  both the page and its test. Phase 1 commit.
- Phase 1: the `upload-pages-artifact` (v3.0.1) and `deploy-pages` (v4.0.5) SHAs in `pages.yml`
  were pinned from memory: the session had no network to resolve the tags. The first Pages run
  in Phase 2 is their check. Phase 1 commit.
- Phase 1: `webAppData.ts` caps the data at 4096 bytes with a `TextEncoder` length check before
  `decodeReceiptUrl`. The 5000-byte test string is the receipt link padded with spaces, which
  `decodeReceiptUrl` alone would record. Phase 1 commit.
- Phase 1: `sendWelcome` takes the URL as an optional argument, and the onboarding middleware's
  welcome (`src/bot/middleware/onboarding.ts`, not in Files touched) still calls it without one.
  A never-onboarded user's first welcome so carries today's menu. `/start` and `/help` carry the
  button. Phase 1 commit.
- Phase 1: `eslint.config.js` gains a `webapp/**/*.ts` block: no import from outside
  `webapp/src/` and no package import, plus `webapp/dist/` in `ignores`. Phase 1 commit.

### Close triggers

- **What shipped:** `webapp/` (index.html with CSP, `main.ts`, `scan.ts`, `messages.ts`,
  `tsconfig.json`), `pnpm build:webapp`, `.github/workflows/pages.yml`, optional `WEBAPP_URL`
  config key, the `web_app_data` handler (`src/bot/handlers/webAppData.ts`), and the
  `menuKeyboardFor` helper in `src/bot/keyboards.ts`.
- **User-visible surface changed:** with `WEBAPP_URL` set, the private `/start` and `/help` menu
  gains «📷 Скан» at the end of its first row. New bot copy `messages.scanButton` and
  `messages.scanNotReceipt`. New page copy in `webapp/src/messages.ts`. README section "Mini
  App: live receipt scan". `.env.example` documents `WEBAPP_URL`.
- **Gate at the tip:** `pnpm typecheck` exit 0, `pnpm lint` exit 0, `pnpm test` exit 0 (117
  files, 1684 tests), `pnpm build` exit 0, `pnpm build:webapp` exit 0 (emits `index.html`,
  `main.js`, `messages.js`, `scan.js`), `node --test "scripts/*.test.mjs"` exit 0 (7 tests),
  `node scripts/check-doc-links.mjs` exit 0.
- **Outstanding `human` phases:** Phase 2 (publish and scan a real receipt), `Blocks merge: no`.

## Followups
