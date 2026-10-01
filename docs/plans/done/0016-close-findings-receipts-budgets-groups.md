# 0016: Close findings: receipt backoff, links with a note, group dates, caps currency, budget navigation

> **Status:** done (2026-10-01): built as planned, three nits open as followups, v0.9.1
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0018](../../adrs/0018-receipts-record-offline-enrich-async.md),
> [ADR-0015](../../adrs/0015-shared-ledgers-carry-a-timezone.md),
> [ADR-0017](../../adrs/0017-budgets-payday-periods-cumulative-allowance.md),
> [ADR-0011](../../adrs/0011-navigation-model.md)

## TL;DR

This plan fixes the open findings from the close reviews of Plans 0009, 0011 and 0014, and one
left over from 0003. Each fix is listed by `conductor.mjs finding NNNN`. The most urgent: a receipt
whose fetched data fails to apply is refetched from the tax site every 5 s, forever. After this
plan it backs off like any other failed fetch. The others: a pasted SUF link with a note after it
goes to the expense parser instead of «ссылка повреждена»; a group expense opened in DM shows and
edits dates in the ledger's timezone; category caps are dropped, with a line saying so, when a
re-set limit changes the budget's currency; and the budget screens get their missing back rows.
It is a fix-only plan: patch bump to v0.9.1.

## Context & problem

The three plans merged with no blockers or majors. Their open minors and nits, verified against
`main` at `a5e0832`:

- **0014 minor 3:** `fetchDueReceipt` applies a fetched receipt in one transaction. A throw there
  rolls back and leaves the receipt `pending` with its `next_fetch_at` unchanged.
  `receiptWorker.ts` catches per drain, so the next tick (`TICK_MS`, 5 s) fetches it again.
- **0014 minor 2:** the [Повторить] double-tap test can't fail on its "fetches once" half, and
  nothing tests the worker's in-flight guard.
- **0014 minor 1:** `rsUrl.ts`'s `URL_PATTERN` matches `[^#]*` to the end of the text, so
  `<link> кофе` and `<link>\n450 кофе` are refused as `malformed`. Plan 0014 Phase 1 says a link
  next to other words is not a receipt.
- **0014 nit:** `tsconfig.build.json` compiles `src/domain/receipts/testing/` and
  `src/fiscal/qr.fixtures/generate.ts` into `dist/`, and the image ships them. The Dockerfile's
  decode check imports `buildRsVl`.
- **0009 minor:** `card.ts` (`sentOn`) and `editExpense.ts` (`today`, three places) use the
  viewer's timezone. For a group expense, the zone is the ledger's (ADR-0015).
- **0011 minor 2:** `category_caps` has no currency. It borrows `ledger_budgets.currency`, which
  `setBudgetLimit` replaces when the ledger's default currency has changed. A 5 000 RUB cap
  becomes 5 000 EUR.
- **0011 minor 3 and both nits:** the budget screen opened from a settings hub has no
  [« Назад]. The cap prompt has no way back to the cap list. The group `/budget` tells the group
  «Задайте лимит заново», which no one there can do.
- **0003 minor:** `/help` doesn't mention `/cancel`. Its other half (categories) is covered now.

## Decision

Fix each finding the way its review suggested. One call is a product decision. **When a re-set
limit changes the budget's currency, the ledger's category caps are deleted in the same
transaction, and the confirmation says so.** That keeps ADR-0017's rule that a budget's amounts
are in one currency. We rejected a `currency` column on `category_caps`, because a cap in a
currency other than the budget's would need its own "not counted" state on every screen. That's
more surface than the rare currency change is worth.

No ADR: the other fixes restore what a plan or ADR already says.

## Architecture diagram

```mermaid
flowchart LR
    W[receiptWorker tick] --> F[fetchDueReceipt]
    F --> R{fetcher}
    R -- failed --> B[failed: attempts+1, next_fetch_at by RETRY_DELAYS_MS]
    R -- fetched --> T[apply transaction]
    T -- ok --> S[settled: card edit]
    T -- throws --> B
```

## Implementation phases

Each phase ships as its own commit. Phases are independent and can land in any order. The order
here puts the external-load fix first.

### Phase 1: A receipt whose data fails to apply backs off
- **Owner skill:** dev
- **What:** In `fetchDueReceipt`, a throw from the apply transaction becomes a failed attempt
  through `failed(deps, receipt, 'error', now)`, the same path as a fetcher throw. It logs ids and
  the error's name only. The worker gets a test of its in-flight guard, and the [Повторить]
  double-tap test gets a half that can fail.
- **Files touched:** `src/services/fetchDueReceipt.ts` (+ test), `src/bot/receiptWorker.ts`,
  `src/bot/receiptWorker.test.ts` (new), `src/bot/bot.test.ts`.
- **Done when:**
  - `fetchDueReceipt.test.ts`: the fetcher answers, and applying the answer throws. The test
    injects the throw, for example through an item the insert rejects. The receipt stays
    `pending` with `attempts = 1` and `next_fetch_at = now + 60_000 ms`, and no items are stored.
    A second `fetchDueReceipt` at the same `now` returns `idle` and doesn't call the fetcher. At
    `now + 60_000 ms` it calls the fetcher again (2 calls in all).
  - `receiptWorker.test.ts`: with a fetcher gated on a promise the test holds, `kick()` twice
    while the first fetch is in flight, then release the gate. The fetcher was called exactly once
    for that receipt.
  - The [Повторить] double-tap test in `bot.test.ts` uses a fetcher that succeeds. After the
    double tap and one `fetchDueReceipt`, a second `fetchDueReceipt` returns `idle`, and the
    fetcher was called once. Reverting the `resetFailedReceipt` CAS to an unconditional update
    makes the test fail. Check this by hand once, and say so in the log.

### Phase 2: A SUF link with a note after it is not a receipt; test code stays out of the image
- **Owner skill:** dev
- **What:** `decodeRsUrl` stops treating whitespace followed by non-base64 text as part of `vl`.
  Such a message is `notReceipt` and goes to the expense parser. A `vl` that form-decoding split
  with spaces still decodes. The build excludes test-only code. The Dockerfile's decode check then
  asserts through production modules only.
- **Files touched:** `src/domain/receipts/rsUrl.ts` (+ test), `tsconfig.build.json`, `Dockerfile`.
- **Done when:**
  - `rsUrl.test.ts`: `buildRsUrl() + ' кофе'` and `buildRsUrl() + '\n450 кофе'` return
    `{ kind: 'notReceipt' }`. The existing `+`, `%2B` and space-in-`vl` cases still decode to
    82912 minor RSD.
  - After `pnpm build`, `dist/` has no `domain/receipts/testing/` and no `fiscal/qr.fixtures/`.
  - The Dockerfile's builder-stage check imports only `dist/fiscal/qr.js` and
    `dist/domain/receipts/index.js`. It keeps `fetch` throwing. It decodes
    `src/fiscal/qr.fixtures/rs-receipt.jpg`, and passes the first text to `decodeReceiptUrl`. It
    exits non-zero unless the result is a receipt of `82912` minor `RSD`. The image build is
    still only seen at deploy, as Plan 0014 Phase 7's first check.

### Phase 3: A group expense in DM uses the ledger's timezone
- **Owner skill:** dev
- **What:** `cardView`'s `sentOn` and the three `today` computations in `editExpense.ts` use
  `effectiveTimezone(deps, user, ledger)` instead of `resolveUserTimezone`. A personal ledger has
  no timezone, so its behavior is unchanged.
- **Files touched:** `src/bot/handlers/card.ts`, `src/services/editExpense.ts` (+ test),
  `src/bot/group/group.test.ts`.
- **Done when:** `group.test.ts`, with `SECOND_ALLOWED_ID` in `America/New_York` and the group
  ledger in `Europe/Belgrade`. `500 такси` is sent in the group at `2026-09-30T23:30:00Z`, which is
  01:30 on 1 October in Belgrade (CEST) and 19:30 on 30 September in New York (EDT). It records
  `occurred_on = '2026-10-01'`. Opened in that member's DM with `/start e_<id>` at the same
  instant:
  - the card has no «за …» date suffix;
  - [Изменить] → date offers `2026-10-01` as today's quick button;
  - typing `01.10` is accepted, not refused as a future date.

  The existing personal-ledger card and edit tests pass unmodified.

### Phase 4: A currency change drops the category caps, and says so
- **Owner skill:** dev
- **What:** In `answerBudgetFlow`'s `budgetLimit` branch, a limit stored in a currency other than
  the budget's current one deletes the ledger's `category_caps` rows. This happens in the same
  transaction as `setBudgetLimit`. The confirmation gains the line «Лимиты по категориям сброшены:
  они были в <old currency>.» from `messages`. A limit re-set in the same currency keeps the caps.
- **Files touched:** `src/db/budgets.ts` (+ test), `src/services/budget.ts` (+ test),
  `src/bot/flows.ts` (`answerFlow`'s `'set'` case passes the dropped caps' currency to the
  screen), `src/bot/handlers/budget.ts`, `src/bot/messages.ts`.
- **Done when:** in `budget.test.ts`, a RUB ledger has a limit of `30000` and a cap of `5000` on
  «Кафе и рестораны» (`500_000` minor RUB).
  - Change the ledger default to EUR, then set the limit `1000`. The budget is `100_000` minor
    EUR, the ledger has 0 cap rows, and the result reports the dropped caps' currency `RUB`.
  - On a fresh fixture, with the currency left alone, set the limit `40000`. The budget is
    `4_000_000` minor RUB and the cap is still `500_000`.
  - A failure inside the transaction leaves both the limit and the caps as they were.

### Phase 5: Budget navigation and the read-only group line
- **Owner skill:** dev
- **What:**
  - `BudgetScreen` gets `fromSettings?: true`, carried through `parseScreen` like
    `CategoriesScreen`. `SETTINGS_BUDGET` sets it, and the screen then ends with
    `backRow(SETTINGS_OPEN)`.
  - The cap prompt gets [« Назад] above [Отмена], which reopens the cap list at its first page.
  - The group `/budget` message drops the «Задайте лимит заново…» sentence. The DM screen keeps
    it.
  - `/help` gains a `/cancel — отменить ввод` line.
- **Files touched:** `src/services/flowSessions.ts` (+ test), `src/bot/flows.ts`
  (`restoreScreen` and `answerFlow` render the budget screen, and the cap flow's cancel),
  `src/bot/handlers/budget.ts`, `src/bot/handlers/settings.ts`, `src/bot/callbackData.ts`,
  `src/bot/messages.ts` (+ test),
  `src/bot/bot.test.ts`, `src/bot/group/group.test.ts`.
- **Done when:**
  - The budget screen opened through `set:bud` has a last row [« Назад] whose data is
    `set:open`. Opened with `/budget`, it has no such row. A `fromSettings` screen survives an
    anchor round trip through `parseScreen`.
  - The cap prompt's keyboard is [Убрать лимит] when the category is capped, then [« Назад] with
    data `bud:caps`, then [Отмена]. Tapping [« Назад] cancels the cap flow and shows the cap list.
  - In a ledger whose budget currency differs from its default, the group `/budget` text lacks
    «Задайте лимит заново». The DM `/budget` text contains it.
  - The `/help` text contains `/cancel`, and stays under 4096 characters.

## Data shapes

```ts
// illustrative
interface BudgetScreen {
  readonly name: 'budget';
  readonly ledgerId: LedgerId;
  readonly fromSettings?: true; // opened from a settings hub: ends with [« Назад] to it
}

type SetLimitResult =
  | { kind: 'set'; droppedCapsCurrency?: CurrencyCode } // present when caps were deleted
  | { kind: 'unchanged' };
```

## Risks & open questions

- **Dropping caps is destructive.** It happens only when the user re-sets the limit after changing
  the ledger's currency, and the confirmation names it. The caps were already being counted in the
  wrong currency, so keeping them would be worse.
- **Phase 2's pattern change touches money parsing at the edge.** The existing refusal tests
  (truncation, flipped byte, refund, invoice types) must still pass unmodified.
- **The Dockerfile check is only exercised at deploy.** A failing check aborts
  `docker compose up --build` before the running container is replaced, so the bot stays up.
- **Privacy:** Phase 1's new log line carries the receipt id and the error's name, never the
  amount, URL or fiscal id.

## What this plan does NOT do

- 0009's nit: the per-person section isn't budgeted against 4096 characters. It's won't-fix at
  family scale.
- Remembering the cap list's page for [« Назад]. It returns to the first page.
- Any conductor change. Those are in Plan 0017.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: A receipt whose data fails to apply backs off | dev | done | 1aac740 |
| 2: A SUF link with a note; test code out of the image | dev | done | b9b047c |
| 3: A group expense in DM uses the ledger's timezone | dev | done | edfecc4 |
| 4: A currency change drops the category caps | dev | done | 1ebafe7 |
| 5: Budget navigation and the read-only group line | dev | done | 63c4ac2 |

### Notes

- Phase 1: `src/bot/receiptWorker.ts` is unchanged; the guard test needed no hook in it. The
  apply throw is injected with a test-only `BEFORE INSERT` trigger on `receipt_items`. Checked by
  hand: with the `resetFailedReceipt` CAS made unconditional, the [Повторить] test fails, on its
  toast assertion (the second tap answers «Загружаю позиции»); the fetch half stays green, since
  both taps land before the fetch. With the worker's `inFlight` check removed,
  `receiptWorker.test.ts` fails with 3 fetcher calls. Both reverted.
- Phase 2: the image build was not run. The Dockerfile check's script body was run by hand
  against a local `pnpm build` and printed `ok 82912 RSD`. A note after the link counts as part
  of `vl` only when it follows a space and is all base64 or percent-encoding characters, so a
  Latin-only note such as `<link> abc` still reaches the decoder and is refused `malformed`.
- Phase 3: `editExpense.test.ts` is unchanged; the behavior is tested in `group.test.ts` only.
  With the old zone, typed `01.10` was not refused as a future date: it was read as
  `2025-10-01` and stored. The test asserts the answer completes the flow and leaves
  `occurred_on = '2026-10-01'`, which fails on the old code. Each of the three changed sites
  was reverted by hand once and failed its half of the test.
- Phase 4 first parked before any code, as `plan_wrong`: the confirmation is rendered in
  `src/bot/flows.ts`, which its `Files touched` did not name. It resumed after the plan named
  it (d726f30). `deleteLedgerCaps` deletes archived
  categories' caps too, and `droppedCapsCurrency` is reported whenever it deleted a row, so a
  ledger whose only cap was on an archived category also gets the line. The failure case is
  injected with a test-only `BEFORE UPDATE` trigger on `ledger_budgets`. No bot-level test shows
  the line on the screen.
- Phase 5: the cap flow is cancelled in the `bud:caps` handler in `src/bot/handlers/budget.ts`,
  not in `src/bot/flows.ts`; `flows.ts` carries the anchor's `fromSettings` into the screen after
  a typed answer. `set:open` from a budget screen opens the hub scoped to that budget's ledger.
  The group `/budget` keeps the first half of the currency line («Бюджет в RSD, а новые траты — в
  EUR.») and drops only the re-set sentence. The DM half of that done-when is checked on the
  screen opened through `set:bud`, since the DM `/budget` opens the personal ledger. Checked by
  hand: with the cancel line removed, the [« Назад] test fails on the pending flow assertion.

### Close triggers

- **What shipped:** 5 `dev` phases in 5 commits: 1aac740, b9b047c, edfecc4, 1ebafe7, 63c4ac2.
- **User-visible surface changed:** a SUF link followed by a note goes to the expense parser; a
  group expense opened in DM shows and edits dates in the ledger's timezone; the budget screen
  after a limit in a new currency opens with «Лимиты по категориям сброшены: они были в <code>.»
  and the caps are gone; the budget screen opened from a scoped settings hub ends with
  [« Назад] to it; the cap prompt has [« Назад] to the cap list; the group `/budget` drops
  «Задайте лимит заново…»; `/help` lists `/cancel — отменить ввод`. New copy:
  `messages.budgetCapsDropped`.
- **Gate at the tip:** `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0, 57
  files, 761 tests; `pnpm build` exit 0; `node scripts/check-doc-links.mjs` exit 0, 134 links.
  The Docker image build was not run.
- **Outstanding `human` phases:** none.

## Close review

# Plan 0016 review, round 1 (tip 14a9e8c)

**Verdict:** clean. All five phases landed as planned, every named test asserts its done-when, and
the gate is green. Three nits are recorded below as followups and none blocks the close.

## Gate (run in this session at the tip)

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`: exit 0, 57 files, 761 tests.
- `node scripts/check-doc-links.mjs`: exit 0, 134 relative links resolve.
- `pnpm build`: exit 0. `dist/domain/receipts/` has no `testing/`, and `dist/fiscal/` has no
  `qr.fixtures/` (checked with `ls`). `dist/` is gitignored, so the tree stayed clean.
- The Docker image build was not run. The plan expects that check to happen at deploy.

## Alignment

- Phase-to-commit map: 1aac740 (P1), b9b047c (P2), edfecc4 (P3), 1ebafe7 (P4), 63c4ac2 (P5),
  plus 25534f6 (P4's park note) and d12826c (main merged in). Every phase has exactly one
  `dev` owner tag. No phase was added or skipped.
- **P1** `fetchDueReceipt.test.ts` "backs off a receipt whose fetched data fails to apply": a
  `BEFORE INSERT` trigger on `receipt_items` makes the apply throw. The test asserts `pending`,
  `attempts 1` and `next_fetch_at = T0 + 60 000 ms`, then 0 items, then that a second run is
  `idle` with 1 fetcher call, then 2 calls at `T0 + 60 000`. Each matches the done-when. The new
  log line carries `receiptId` and the error's name only.
  `receiptWorker.test.ts` gates the fetcher and calls `kick()` twice while the fetch is in
  flight. It asserts `fetcherCalls === 1` and `fetched`. The log says this fails with 3 calls
  when the `inFlight` check is removed.
  `bot.test.ts`, the [Повторить] test: the fetcher succeeds, and the test asserts `settled`, then `idle`,
  then `fetches === 1`. See nit 3.
- **P2** `rsUrl.test.ts` checks `' кофе'` and `'\n450 кофе'` → `notReceipt`. The `%2B` / `+` /
  space case now asserts `82912` `RSD`, not only `kind`. The existing refusal tests are
  unmodified. The Dockerfile check imports only `dist/fiscal/qr.js` and
  `dist/domain/receipts/index.js`. It keeps `fetch` throwing and asserts `82912` / `RSD`.
- **P3** `group.test.ts` covers New York / Belgrade at `2026-09-30T23:30:00Z` and asserts
  `occurred_on '2026-10-01'`. The card asserts no ` за `. The first quick button is
  `exp:dt:<id>:2026-10-01`. Typing `01.10` completes the flow, and the test asserts the date stays
  `2026-10-01`. That assertion fails on the old zone, which read `01.10` as 2025. All three
  `editExpense.ts` sites and `cardView` use `effectiveTimezone`.
- **P4** `budget.test.ts` "a limit in a new currency" checks three cases:
  - EUR `1000` gives `100_000` EUR, no caps and `droppedCapsCurrency: 'RUB'`.
  - The same currency at `40000` gives `4_000_000` RUB and keeps the cap at `500_000`.
  - An injected `BEFORE UPDATE` trigger leaves `3_000_000` RUB and the cap `500_000`.

  `deleteLedgerCaps` runs inside `answerBudgetFlow`'s transaction. `db/budgets.test.ts` checks
  that it covers archived categories and leaves the other ledger alone.
- **P5** has four done-whens:
  - `set:bud` → last row `« Назад` / `set:open` is asserted in `group.test.ts`. It survives a
    typed limit through `flows.ts`.
  - The exact `/budget` keyboard in `bot.test.ts:1792` has no back row.
  - `flowSessions.test.ts` round-trips `fromSettings`.
  - The cap prompt keyboard is asserted row by row, `[« Назад]` cancels the flow (`kind` null),
    and a later `6000` leaves the cap at `500_000`. The group `/budget` lacks «Задайте лимит
    заново», and the DM screen opened through `set:bud` has it (deviation disclosed: the DM
    `/budget` opens the personal ledger). `/help` contains `/cancel — отменить ввод` and stays
    under 4096 characters.
- No ADR was reversed. ADR-0017's "one currency per budget" is kept by deleting the caps, as the
  plan decided.

## Layering and correctness

- grammY stays in `src/bot/`. The new copy (`budgetCapsDropped`, the `/cancel` line, the
  read-only split of `budgetScreen`) lives in `messages.ts`. No SQL outside `src/db/`.
- Money stays integer. No new float or `toFixed`. Time uses the injected `now` and the ledger's
  zone where ADR-0015 requires it.
- The cap-list handler's `cancelFlowIf(... 'budgetCap')` is idempotent under a double tap.
  Callback data is unchanged in size (`bud:caps`, `set:open`).

## Findings

### blocker

None.

### major

None.

### minor

None.

### nit

1. **A Latin-only note after a SUF link is still refused as a broken link.**
   - **Where:** `src/domain/receipts/rsUrl.ts:18-19`.
   - **What:** the pattern `(?: +[A-Za-z0-9+/=%&]+)*` treats a space plus base64-alphabet text
     as part of `vl`, so `<link> kafa` or `<link> lunch` reaches the decoder and is answered
     «ссылка повреждена». Only a note that contains a non-base64 character (Cyrillic, `č`, a
     digit-space mix with newline) goes to the parser.
   - **Why it matters:** this follows the plan's wording ("non-base64 text") and the log
     discloses it. Plan 0014 Phase 1's rule, that a link next to other words is not a receipt,
     still fails for Latin words, and users in RS/ME type Latin.
   - **Suggested fix (followup):** accept a space-split tail only when the rejoined `vl`
     base64-decodes to a valid journal. Otherwise retry the match without the tail and route it
     as `notReceipt`.
2. **No bot-level test shows the «Лимиты по категориям сброшены» line.**
   - **Where:** `src/bot/flows.ts:165` and `src/bot/handlers/budget.ts` `budgetView`'s header.
   - **What:** the service test covers `droppedCapsCurrency`. Nothing asserts that the screen
     after the typed limit starts with the line. The plan's done-when only named the service
     result, and the log discloses the gap.
   - **Why it matters:** dropping the `droppedCapsCurrency` argument in `flows.ts` would pass the
     whole suite.
   - **Suggested fix (followup):** one `bot.test.ts` case: RUB limit, then a cap, then the
     currency set to EUR, then a new limit. Assert that the edited text starts with
     `Лимиты по категориям сброшены: они были в RUB.`
3. **The [Повторить] double-tap test's "fetches once" half still cannot fail.**
   - **Where:** `src/bot/bot.test.ts` ~3820-3842.
   - **What:** both taps land before the fetch, so `fetches === 1` holds even with the
     `resetFailedReceipt` CAS made unconditional. The test does fail under that mutation, but on
     its toast assertion. The log discloses this. The done-when ("makes the test fail") is met.
   - **Why it matters:** the original 0014 finding named this half. The guard is now defended by
     the toast assertion instead.
   - **Suggested fix (followup):** none needed unless the toast assertion is ever relaxed. If it
     is, run one `fetchDueReceipt` between the two taps and assert that the second tap neither
     re-queues nor refetches.

## Bookkeeping owed at close

- Flip `Status:` to `done` (2026-10-01, this verdict), `git mv` the plan to `docs/plans/done/`,
  repair links both ways, and run `node scripts/check-doc-links.mjs`.
- No paired ADR to accept (the plan says no ADR).
- Refresh `docs/plans/README.md`: move the row to recently closed.
- Version: the patch bump to **v0.9.1** that the plan names. Add the `CHANGELOG.md` entry and a
  `versionAnnouncements` entry in `messages.ts`. The user-visible surface is listed in the log's
  close triggers.
- Docs: `/help` already carries `/cancel`. No env var or config key changed. The README needs no
  change.
- Record nits 1 to 3 under the plan's `## Followups`.

### Earlier rounds

Round 1 was the only review round. No fix round ran, so no finding was resolved by a fix commit.

## Followups

- Review nit 1: a Latin-only note after a SUF link (`<link> kafa`) is still refused as
  «ссылка повреждена». Accept a space-split tail of `vl` only when the rejoined value decodes to
  a valid journal; otherwise route the message as `notReceipt`.
- Review nit 2: add a `bot.test.ts` case asserting the budget screen after a limit in a new
  currency starts with «Лимиты по категориям сброшены: они были в RUB.»
- Review nit 3: if the [Повторить] test's toast assertion is ever relaxed, run one
  `fetchDueReceipt` between the two taps and assert the second tap neither re-queues nor refetches.
