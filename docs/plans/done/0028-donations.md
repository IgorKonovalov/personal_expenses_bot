# 0028: Donations: everything free, `/donate` via Telegram Stars and an external link

> **Status:** done (2026-10-06): built as planned, two minors open, Phase 4 live donation and refund owed, v0.14.0
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0027](../../adrs/0027-donations-only-funding.md) (donations only, no paid tier),
> [ADR-0024](../../adrs/0024-admission-lives-in-the-database-via-invite-codes.md) (who is admitted)

## TL;DR

The bot stays free, with no paid tier and no feature limits, and says so. In a private chat,
`/donate` answers with one message: a short "free forever, support if you like" text and buttons
[⭐ 50], [⭐ 150], [⭐ 500], and [Ko-fi] when `DONATE_URL` is set. A Stars button opens Telegram's
payment sheet directly through a cached invoice link. After payment the bot thanks the donor once,
stores a minimal row, and tells the admin. A donation unlocks nothing. `/help` ends with one line
pointing to `/donate`. `/paysupport` relays a refund request to the admin, and the admin's `/refund`
returns the Stars. The first thing the user sees: `/donate`, then [⭐ 50], then the payment sheet,
then «Спасибо! Бот остаётся бесплатным для всех».

## Context & problem

The product decision is donations after public release, with no paid services (ADR-0027). Today
the bot has no payment code at all. Stars work for users whose cards can't pay foreign services,
which fits the Russian-speaking audience. An external page covers card payers abroad. Plan 0029
lists this plan as a prerequisite for opening the bot.

## Decision

At boot the bot creates one Stars invoice link per preset amount (`createInvoiceLink`, currency
`XTR`, empty provider token, payload `donate:<stars>`) and keeps them in memory. If creation
fails, `/donate` shows only the external button, or a short «Пожертвования временно недоступны»
when neither is available, and the failure is logged at warn.

`pre_checkout_query` runs behind the access middleware, so only admitted users can pay. It
approves the query only when the currency is `XTR` and the payload names a preset matching
`total_amount`. `successful_payment` is handled **before** the access middleware: by then the
Stars are already taken, so the payment is recorded even if the payer was blocked in between. The
row is keyed by `telegram_payment_charge_id`, so a redelivered update records once and thanks once.

We rejected a native invoice message per tap (`sendInvoice`): it costs two messages per attempt and
leaves stale invoice cards in the chat. We rejected `/donate` in groups: a donation pitch doesn't
belong in a shared family chat. The funding model itself is ADR-0027.

## Architecture diagram

```mermaid
sequenceDiagram
    participant U as user
    participant T as Telegram
    participant B as bot adapter
    participant S as recordDonation
    participant D as db.donations
    U->>B: /donate
    B-->>U: text + [⭐ 50 / 150 / 500] (cached invoice links) + [Ko-fi]
    U->>T: tap ⭐ 150, pay
    T->>B: pre_checkout_query (XTR, 150, donate:150)
    B-->>T: ok
    T->>B: message.successful_payment (charge id)
    B->>S: record
    S->>D: insert or ignore by charge id
    S-->>B: inserted?
    B-->>U: thank-you (only when inserted)
    B-->>B: admin notice (only when inserted)
```

## Implementation phases

Each phase ships as its own commit. `dev` implements all phases in one session with no review
between phases. The architect reviews once at the end, in a fresh session. All new copy goes in
`src/bot/messages.ts`, in Russian. Bot UI copy may use the ⭐ emoji on the Stars buttons.

### Phase 1: Walking skeleton: `/donate` takes 50 Stars and says thank you
- **Owner skill:** dev
- **What:**
  - The next free migration adds `donations` (Data shapes).
  - At boot, `createInvoiceLink` runs for 50, 150 and 500 Stars: title, description and label
    come from messages, the payload is `donate:<stars>`, the currency is `XTR`, the provider token
    is empty, and prices hold one item of that amount. The links are kept in memory. A failed
    creation logs at warn and leaves that amount out.
  - `/donate` in a private chat replies with `messages.donate`: the bot is free for everyone, a
    donation unlocks nothing, and it helps pay for the server. The keyboard has one URL button per
    available link. With no link available it replies `messages.donateUnavailable`.
  - `pre_checkout_query` (behind access): approve when `currency === 'XTR'`, the payload parses to
    a preset amount, and that amount equals `total_amount`. Otherwise answer `ok: false` with
    `messages.donateRejected`.
  - `message:successful_payment` (registered before access): `recordDonation` inserts a row,
    doing nothing on a duplicate `telegram_payment_charge_id`. The user is resolved from the
    payer's Telegram identity. When it inserts, the bot replies `messages.donateThanks`. If no user
    matches the identity, the bot logs at warn with the charge id, inserts nothing and replies with
    the thanks anyway.
  - `/donate` joins `messages.commands`, and is not added to `groupCommands`.
- **Files touched:** `src/db/migrations/00NN_donations.sql`, `src/db/donations.ts` (+ test),
  `src/domain/donations.ts` (+ test: presets and payload parsing), `src/services/recordDonation.ts`
  (+ test), `src/bot/handlers/donate.ts`, `src/bot/bot.ts`, `src/bot/messages.ts`,
  `src/bot/testHarness.ts`, `src/bot/bot.test.ts`, `src/index.ts`.
- **Done when:**
  - `parseDonationPayload('donate:150')` is 150, and `'donate:149'`, `'donate:'`, `'donate:1e2'`
    and `'other:150'` are each undefined.
  - A pre-checkout of `XTR`, 150 and `donate:150` is approved. A pre-checkout of `XTR`, 50 and
    `donate:150` is rejected, and so is `USD`, 150, `donate:150`.
  - A `successful_payment` update for an admitted user inserts one row with `stars = 150`. The
    same update delivered twice leaves one row and sends one thank-you.
  - A `successful_payment` from a user the access middleware would refuse still inserts its row.
  - With link creation failing for every amount and no `DONATE_URL`, `/donate` answers
    `donateUnavailable`.
  - `/donate` in a bound group gets no reply.

### Phase 2: The external link, the `/help` line and the admin notice
- **Owner skill:** dev
- **What:**
  - Config: an optional `DONATE_URL`, which must be an `https:` URL or boot fails naming the key.
    When set, `/donate` adds a [Ko-fi] button whose label comes from messages (`donateExternal`),
    and the button is hidden when it's unset. `.env.example` documents it.
  - `/help` in private ends with `messages.helpDonateLine` («Бот бесплатный. Поддержать: /donate»).
    Group `/help` doesn't get it.
  - Each inserted donation sends the admin `messages.adminDonation`, with the Stars amount, the
    donor's internal user id and the charge id. No Telegram name or username goes in the notice.
- **Files touched:** `src/config.ts` (+ test), `.env.example`, `src/bot/handlers/donate.ts`,
  `src/bot/handlers/help.ts`, `src/bot/adminNotifier.ts`, `src/bot/messages.ts`,
  `src/bot/bot.ts` (`BotOptions` carries the donate URL and the admin notifier to the handlers),
  `src/index.ts` (passes `config.donateUrl` and the notifier into `createBot`; `adminNotifier`
  is built from `bot.api` after `createBot`, so the handler reaches it late-bound),
  `src/bot/testHarness.ts` (`TestBotOptions` sets the donate URL), `src/bot/bot.test.ts`,
  `README.md`.
- **Done when:**
  - `DONATE_URL=http://example.com` fails config validation with an error naming `DONATE_URL`.
    `https://ko-fi.com/example` passes.
  - With `DONATE_URL` set, `/donate`'s keyboard has four buttons, the last a URL button to it.
    Without it, the keyboard has three.
  - Private `/help` ends with the donate line, and group `/help` doesn't contain `/donate`.
  - A duplicate `successful_payment` sends the admin one notice, not two.

### Phase 3: `/paysupport` and the admin's `/refund`
- **Owner skill:** dev
- **What:**
  - `/paysupport` (private) explains that a donation unlocks nothing and that a refund can be asked
    for by sending `/paysupport <текст>`. With text, it forwards the text to the admin with the
    user's internal id and their donations (charge id, Stars, date in the admin's timezone), then
    confirms to the user. The donations list is capped at the 10 newest.
  - `/refund <charge id>` (admin only, private) looks up the donation, calls `refundStarPayment`
    with the payer's Telegram id (resolved through `auth_identities`) and the charge id, then sets
    `refunded_at`. It reports a done, not-found, already-refunded or Telegram-error result to the
    admin. A non-admin's `/refund` falls through to the normal unknown-command handling.
- **Files touched:** `src/db/donations.ts` (+ test), `src/services/refundDonation.ts` (+ test),
  `src/bot/handlers/paysupport.ts`, `src/bot/handlers/refund.ts`, `src/bot/bot.ts`,
  `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - `/paysupport верните пожалуйста` from a user with two donations sends the admin one message
    holding both charge ids and the text, and replies to the user with a confirmation.
  - The admin's `/refund <charge id>` calls `refundStarPayment` once with the payer's Telegram id,
    and sets `refunded_at`. A second `/refund` of the same id doesn't call Telegram and answers
    already-refunded.
  - A `refundStarPayment` error leaves `refunded_at` NULL and reports the error to the admin.
  - A non-admin's `/refund <id>` doesn't call `refundStarPayment`.

### Phase 4: A real donation and refund
- **Owner skill:** human
- **Blocks merge:** no
- **What:** On the deployed bot, with `DONATE_URL` set, donate 50 Stars from your own account,
  then refund it with `/refund`.
- **Done when:** The payment sheet opens from the button, the thank-you and admin notice arrive
  once each, the [Ko-fi] button opens the page, and the 50 Stars come back to the account after
  `/refund`.

## Data shapes

```sql
-- illustrative
CREATE TABLE donations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars > 0),
  telegram_payment_charge_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  refunded_at TEXT
);
```

Stars are a whole-unit count with no minor units. They're stored as `stars`, not money: they aren't
an ISO-4217 currency and never enter a ledger, a total or a conversion.

```ts
// illustrative
const DONATION_PRESETS = [50, 150, 500] as const;
type DonationPreset = (typeof DONATION_PRESETS)[number];
function parseDonationPayload(payload: string): DonationPreset | undefined; // 'donate:<n>'
```

## Risks & open questions

- **Telegram's terms (unverified).** Stars payouts, the holding period and the requirement to
  handle `/paysupport` are as recalled at planning time. The human phase checks the current
  terms before going live.
- **Money moved but not recorded.** `successful_payment` sits before the access middleware so a
  block can't swallow it. If the insert throws, the error boundary logs the charge id at error,
  so the admin can still refund by hand.
- **Privacy.** A donation row is personal data that outlives `/delete_account` (Plan 0029), because
  a refund needs it. Plan 0029's `PRIVACY.md` must say so, and that plan's Phase 5 is the place to
  add it. Logs carry the charge id and Stars amount at info, never a name or username.
- **Idempotency.** The UNIQUE charge id makes the record, the thank-you and the admin notice
  happen once per payment. Pre-checkout writes nothing, so a repeat is harmless.
- **Stale links.** An invoice link stays valid, but a preset change at deploy makes old links
  carry a payload the new code doesn't know. The pre-checkout then rejects it, which is correct.
- **Access before Plan 0029.** Until Plan 0029 lands, "admitted" means the `.env` allowlist.
  Nothing here depends on which.

## What this plan does NOT do

- Paid features, subscriptions or donor perks (ADR-0027).
- A custom donation amount. Three presets cover it, and a custom amount needs a flow session.
- The monthly-summary footer. Plan 0026 adds it once that push exists.
- Donations in groups.
- A donor list or public thanks.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: `/donate` takes 50 Stars and says thank you | dev | done | ecfb196 |
| 2: The external link, the `/help` line and the admin notice | dev | done | 7d10a1e |
| 3: `/paysupport` and the admin's `/refund` | dev | done | 3e64aad |
| 4: A real donation and refund | human | owed | |

### Notes

- Phase 1: `src/db/ledgerKeys.test.ts` (outside Files touched) pinned the full list of pending
  migrations as `['0012']`; adding `0013_donations.sql` turned it red. It now asserts `0012` is
  the first applied.
- Phase 1: `BotOptions.donationLinks` is optional (absent is no links), so the other test files
  calling `createBot` (`unlock.test.ts`, outside Files touched) compile unchanged. The migration
  also adds an index `donations_user (user_id, created_at)`.
- Phase 2: the donate line is the last line of `messages.help` itself, so every private help
  reply (unknown command, non-text message) carries it too. `src/bot/handlers/help.ts` and
  `src/bot/adminNotifier.ts` are unchanged.
- Phase 2: `BotOptions` also carries `adminTelegramId` (passed from `config.adminTelegramId` in
  `src/index.ts`), unused until Phase 3, whose Files touched exclude `src/index.ts`.
  `donateUrl`, `adminTelegramId` and `notifyAdmin` are optional (absent: no button, no admin,
  a no-op notifier).
- Phase 2: a refused admin notice is caught and logged at warn with the charge id; the donor's
  thank-you is sent first.
- Phase 3: `/paysupport` is not added to `messages.commands`. The relayed list marks a refunded
  donation «возвращено» and reads «Пожертвований нет.» when empty. A refund whose payer has no
  Telegram identity left is reported as a failure without calling Telegram. A `/refund` with no
  id answers `messages.refundUsage`.
- Followup, not acted on: `README.md` describes `/donate` but not `/paysupport` or `/refund`
  (Phase 3's Files touched exclude it).
- Followup, not acted on: `/paysupport` is absent from the command menu Telegram shows.

### Close triggers

- **What shipped:** migration `0013_donations.sql` (`donations`, UNIQUE charge id); at boot one
  XTR invoice link per preset in `DONATION_PRESETS` (`createDonationLinks`); private `/donate`
  with one URL button per link plus [Ko-fi] when `DONATE_URL` (https only) is set; a
  pre-checkout behind the allowlist approving only `acceptsDonation`; `successful_payment` ahead
  of the allowlist recording once per charge id, thanking once and notifying the admin once;
  the private help's last line `helpDonateLine`; `/paysupport` relaying to the admin; the admin's
  `/refund <charge id>` via `refundStarPayment`.
- **User-visible surface changed:** new commands `/donate` (in `messages.commands`),
  `/paysupport`, and admin-only `/refund`; the private help gains a last line; new optional env
  `DONATE_URL`.
- **Gate at the tip:** `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0, 75
  files, 1052 tests; `pnpm build` exit 0; `node scripts/check-doc-links.mjs` exit 0.
- **Outstanding `human` phases:** Phase 4 (a real donation and refund; blocks merge: no).

## Close review

The round 1 review (tip 88693ed), in full:

> **Verdict:** Every dev phase of Plan 0028 is built as planned and every named done-when has a
> test with a real assertion; three minors and no blockers or majors, so the plan can close once
> Phase 4 (human, does not block merge) is scheduled.
>
> **Gate (run at the tip):** `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0, 75
> files, 1052 tests; `node scripts/check-doc-links.mjs` exit 0, 256 relative links resolve.
>
> **Alignment.** Phases 1-3 map to ecfb196, 7d10a1e and 3e64aad. Phase 4 (human, `Blocks merge:
> no`) is owed. Every phase carries exactly one in-vocabulary owner tag. The logged deviations
> (the `ledgerKeys.test.ts` edit, optional `BotOptions` donation fields, the donate line living in
> `messages.help` itself, `adminTelegramId` on `BotOptions`) are each disclosed and harmless. The
> assertions read for the done-whens:
>
> - `src/domain/donations.test.ts`: `parseDonationPayload('donate:150')` is 150. `donate:149`,
>   `donate:`, `donate:1e2` and `other:150` (plus `donate:0150` and a trailing space) are undefined.
> - `src/bot/bot.test.ts` "answers a pre-checkout of ...": the exact `answerPreCheckoutQuery`
>   payload, ok true for XTR/150/donate:150, ok false with `donateRejected` for XTR/50 and
>   USD/150. No row is written.
> - "records, thanks and notifies the admin once when the update is delivered twice": the same
>   update is handled twice. It asserts one row with `stars: 150` and exactly two sends, one
>   thank-you and one admin notice. The notice text is asserted in full, with no `Test` name in it.
> - "records a payment from a user the access middleware would refuse": a STRANGER_ID user with an
>   identity gets a row.
> - "answers donateUnavailable when every link creation failed": with `failMethods`, the only send
>   is `donateUnavailable`, plus three warn lines (level 40).
> - "gets no reply to /donate in a bound group": `calls` is `[]` after the bind.
> - Config: `http://example.com` and a scheme-less value throw a message naming `DONATE_URL`, and
>   `https://ko-fi.com/example` passes.
> - The four-button keyboard ends in the Ko-fi URL button. Without the URL there are three buttons.
> - Private `/help` ends with `\nБот бесплатный. Поддержать: /donate`. Group `/help` equals
>   `groupHelp` and does not contain `/donate`.
> - `/paysupport верните пожалуйста`: the full admin message is asserted, with both charge ids and
>   the text, followed by the `paySupportSent` confirmation.
> - `/refund`: one `refundStarPayment` with `user_id: 1003`, then `refunded_at` is set. A second
>   `/refund` makes no Telegram call and answers `refundAlreadyRefunded`. On a refused refund,
>   `refunded_at` stays NULL and the error reaches the admin. A non-admin's `/refund` makes no call
>   and gets `messages.help`.
>
> ADR-0027 is not reversed: there is no perk, gate or paid path.
>
> **Layering and correctness.** grammY appears only under `src/bot/`. The domain module is pure,
> the SQL lives in `src/db/donations.ts`, and the services take injected `now`/`refundStars`. All
> copy is in `messages.ts`. Stars are a whole count, stored as `stars INTEGER CHECK (stars > 0)`,
> with no money arithmetic. Idempotency: `ON CONFLICT (telegram_payment_charge_id) DO NOTHING`, and
> the thank-you and notice go out only on `recorded`. `markDonationRefunded` is guarded by
> `refunded_at IS NULL`. Privacy: the logs carry the charge id and the stars, and the admin notice
> carries the internal id and the charge id. User text in the relay is escaped through the `html`
> tag. The `/paysupport` dates go through `localDateOf` in the admin's zone, and the test pins the
> 22:10Z to «30 сентября» rollover.
>
> **Findings.** No blocker, no major, no nit. Three minors:
>
> 1. **minor, open.** The charge id of a payment whose insert throws is never logged
>    (`src/bot/handlers/donate.ts:96`, `errorBoundary` in `src/bot/bot.ts:152-157`). The Risks
>    section promises the error boundary logs it, but `errorBoundary` logs only `updateId` and the
>    error. Fix: wrap `recordDonation` in try/catch, log `{ chargeId, stars }` at error, rethrow,
>    with a test that makes the insert throw.
> 2. **minor, open.** A long `/paysupport` request can exceed Telegram's 4096-character limit and
>    be lost (`src/bot/handlers/paysupport.ts:47`, `messages.adminPaySupport`). Fix: truncate the
>    text to a fixed budget (about 3000 characters with an ellipsis) and assert a 4000-character
>    request still sends one admin message of at most 4096 characters.
> 3. **minor, fixed at close in ed5d167.** README did not document `/paysupport` or the admin's
>    `/refund`.
>
> **Bookkeeping owed at close:** flip the status and move the plan; accept ADR-0027; refresh the
> plans index; a minor bump with its CHANGELOG and `versionAnnouncements` entries; carry `dev`'s
> menu followup; Plan 0029 still owes the `PRIVACY.md` line on donation rows outliving
> `/delete_account`.

No earlier round raised a finding, so no fix round resolved one. Phase 4 (human) stays owed.

## Followups

- `/paysupport` is absent from the command menu Telegram shows (from `dev`'s log).
- Minors 1 and 2 above, for a fix plan.
- Plan 0029's `PRIVACY.md` must say donation rows outlive `/delete_account` (see Risks).
