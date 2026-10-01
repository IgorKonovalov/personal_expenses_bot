# 0011: Budgets: a payday-period limit, a daily allowance, essential categories and category caps

> **Status:** in-progress (2026-10-01)
> **Created:** 2026-09-30
> **Related ADRs:** [ADR-0017](../adrs/0017-budgets-payday-periods-cumulative-allowance.md),
> [ADR-0015](../adrs/0015-shared-ledgers-carry-a-timezone.md),
> [ADR-0003](../adrs/0003-currency-conversion-at-report-time.md)

## TL;DR

A ledger gets a budget: an overall limit for a period that starts on any day of the month
(payday), an optional scope of "optional spending only", and optional caps per category. After
every recorded expense the DM card shows one more line with what's left for today and for the
period. The daily figure is cumulative: yesterday's leftover or overspend moves into today
(ADR-0017). The design copies ZenMoney's "spending limit for a period" widget. The first thing
the user sees: they set a limit of 30 000 in `/budget`, write `450 кофе`, and the card answers
«Осталось на сегодня: 517,74 ₽ · до 31 окт: 29 550 ₽».

## Context & problem

The bot answers "how much did I spend", but not "how much can I still spend". Plan 0009 names
budgets as the next plan. Everything needed to count spending exists: `expenses` rows by ledger
and `occurred_on`, `periodSummary`, and the effective timezone from ADR-0015. What's missing:

- **A period that isn't a calendar month.** `src/domain/periods.ts` knows only `weekOf` and
  `monthOf`. A payday on the 10th needs the 10th to the 9th.
- **A daily figure with a rounding rule.** Integer minor units divided by the days in a period
  don't divide evenly, so the rule has to keep the per-day amounts adding up to exactly the limit.
- **A way to exclude fixed costs.** Rent and groceries shouldn't eat the café allowance. Categories
  have no essential/optional distinction.
- **Currencies.** A ledger can hold expenses in several currencies and there's no FX (ADR-0003).

## Decision

One `ledger_budgets` row per ledger, plus `category_caps` rows and a `categories.essential` flag.
Everything is computed at read time by a pure domain module (`src/domain/budget.ts`) and one
service (`src/services/budget.ts`), in the effective timezone, over expenses in the budget's
currency (ADR-0017). The DM card and a `/budget` screen render it. Group ledgers get the same
budget. It's set from the group ledger's settings screen in DM (Plan 0009 Phase 4) and shown in
the group with `/budget`, but group confirmations stay a quiet reaction.

We rejected the average daily mode, calendar-month-only periods and FX conversion inside this
plan. See ADR-0017. We also rejected materialising daily allowances in a table: edits, deletions
and past dates would each have to rewrite it.

## Architecture diagram

```mermaid
flowchart LR
    subgraph adapter[bot adapter]
        C[DM expense card]
        B[/budget screen + setup flows]
        G[group /budget]
    end
    subgraph services
        S[budget.ts: budgetStatus ledger, today]
    end
    subgraph domain
        P[periods.ts: budgetPeriodOf startDay]
        A[budget.ts: allowance floor L*d/N]
    end
    subgraph db
        LB[(ledger_budgets)]
        CC[(category_caps)]
        E[(expenses + categories.essential)]
    end
    C --> S
    B --> S
    G --> S
    S --> P
    S --> A
    S --> LB
    S --> CC
    S --> E
```

## Implementation phases

Each phase ships as its own commit. Every worked number below uses RUB (exponent 2) and the
ledger default currency RUB, with a clock injected into tests.

### Phase 1: Walking skeleton: a calendar-month limit and the card line
- **Owner skill:** dev
- **What:** `/budget` (command and a menu entry) opens a screen with [Задать лимит]. That starts
  an ADR-0009 flow that reads an amount with `parseAmount` in the ledger's default currency and
  stores `ledger_budgets` (start day 1, scope `all`). The DM expense card gains one line with
  what's left today and for the period. The deleted card has no line. The line is recomputed
  every time the card renders, so a category change or an edit shows current numbers.
- **Files touched:** `src/db/migrations/0008_budgets.sql`, `src/db/budgets.ts` (+ test),
  `src/domain/budget.ts` (+ test), `src/services/budget.ts` (+ test), `src/bot/handlers/budget.ts`,
  `src/bot/handlers/card.ts`, `src/bot/handlers/menu.ts` (the menu entry), `src/bot/bot.ts`
  (registration), `src/services/flowSessions.ts` (+ test: the `budget` screen and the limit flow
  in the `Screen`/`Flow` unions, `parseScreen`/`parseFlow`), `src/bot/flows.ts` (`answerFlow`,
  `restoreScreen`), `src/bot/callbackData.ts`, `src/bot/keyboards.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`.
- **Done when:**
  - `src/domain/budget.test.ts`: `allowanceThrough(L, N, d)` = `floor(L * d / N)`. For
    `L = 3_000_000`, `N = 31`: day 1 → `96_774`, day 2 → `193_548`, day 31 → `3_000_000`. For
    `L = 1_000_000`, `N = 30`: day 1 → `33_333`, day 2 → `66_666`, day 30 → `1_000_000`. It's
    monotonic for every `d` in `1..N` over both cases.
  - `src/services/budget.test.ts`, with a limit of `30000` set on the personal ledger and today
    `2026-10-01` in `Europe/Moscow`: after `450 кофе`, today's remainder is `51_774` minor
    (`96_774 − 45_000`) and the period remainder is `2_955_000`. On `2026-10-02`, after `300 такси`,
    today's remainder is `118_548` (`193_548 − 75_000`) and the period remainder is `2_925_000`.
  - Overspend: a limit of `30000`, and `1500 ресторан` on `2026-10-01` gives today's remainder as
    `−53_226`. On `2026-10-02` with no new spend, today's remainder is `43_548`
    (`193_548 − 150_000`). The card renders a negative remainder with the overspend copy, not as
    `-532,26`.
  - An expense in `EUR` on the RUB ledger changes neither remainder. The `/budget` screen lists it
    under «Не учтено». A deleted expense (`deleted_at` set) doesn't count.
  - With no budget set, the card text is exactly today's card text. The existing card tests'
    expected strings don't change.
  - `src/bot/bot.test.ts`: a redelivered `450 кофе` update (the same `source_key`) leaves the
    period remainder at `2_955_000`, not `2_910_000`.

### Phase 2: Payday periods
- **Owner skill:** dev
- **What:** The `/budget` screen gets [День начала периода], which reads a day from 1 to 31 through
  a flow. `budgetPeriodOf(date, startDay)` in `src/domain/periods.ts` implements ADR-0017's rule,
  and the budget service uses it instead of `monthOf`. The card line's "до <date>" names the
  period's last day.
- **Files touched:** `src/domain/periods.ts` (+ test), `src/services/budget.ts` (+ test),
  `src/services/flowSessions.ts` (+ test: the start-day flow), `src/bot/flows.ts`,
  `src/bot/handlers/budget.ts`, `src/bot/callbackData.ts`, `src/bot/messages.ts`.
- **Done when:** `src/domain/periods.test.ts` asserts, as `[from, to]` inclusive with the length
  in days:
  - start 1, `2026-10-05` → `[2026-10-01, 2026-10-31]`, 31 days (the same as `monthOf`).
  - start 10, `2026-10-05` → `[2026-09-10, 2026-10-09]`, 30 days.
  - start 10, `2026-10-10` → `[2026-10-10, 2026-11-09]`, 31 days.
  - start 31, `2027-02-15` → `[2027-01-31, 2027-02-27]`, 28 days.
  - start 31, `2027-02-28` → `[2027-02-28, 2027-03-30]`, 31 days.
  - start 30, `2028-02-29` (a leap year) → `[2028-02-29, 2028-03-29]`, 30 days.

  And in `src/services/budget.test.ts`, with start 10 and a limit of `30000` on `2026-10-10`
  (day 1 of a 31-day period), an expense dated `2026-10-09` belongs to the previous period and
  doesn't change today's remainder of `96_774`.

### Phase 3: Essential categories and the optional-only scope
- **Owner skill:** dev
- **What:** `categories.essential` (0/1). Presets seed `groceries`, `housing`, `health`,
  `telecom` and `transport` as essential and the rest as optional (a product guess, stated
  below). The categories screen gets a set-not-toggle action (`cat:ess:<id>:<0|1>`, so a
  double tap is idempotent), and the `/budget` screen gets [Считать: все / только
  необязательные]. With scope `optional`, the limit counts only expenses whose category isn't
  essential. An uncategorised (`NULL`) expense counts as optional.
- **Files touched:** `src/db/migrations/0009_category_essential.sql`, `src/db/categories.ts` (+
  test), `src/domain/categoryPresets.ts`, `src/services/seedCategories.ts` (+ test),
  `src/services/manageCategories.ts` (+ test), `src/services/budget.ts` (+ test),
  `src/bot/handlers/categories.ts`, `src/bot/handlers/budget.ts`, `src/bot/callbackData.ts`,
  `src/bot/messages.ts`.
- **Done when:**
  - With scope `optional`, a limit of `20000`, and `3000 продукты` plus `450 кофе` on the period's
    first day, period spent is `45_000` and the period remainder is `1_955_000`. With scope `all`,
    the same data gives `345_000` spent.
  - The migration marks existing preset rows by `preset_key` (the same five as essential) and
    leaves user-created categories optional. A test runs it over a pre-migration fixture.
  - Tapping `cat:ess:<id>:1` twice leaves `essential = 1` and sends one edit, not a toggle back.

### Phase 4: Per-category caps
- **Owner skill:** dev
- **What:** The `/budget` screen gets [Лимиты по категориям]: a paged category list where a
  category can be given a cap for the period, or have its cap cleared. A cap can exist without an
  overall limit. The screen lists each capped category as "spent of cap". The DM card adds a
  second line only when the expense's category has a cap.
- **Files touched:** `src/db/budgets.ts` (+ test), `src/services/budget.ts` (+ test),
  `src/services/flowSessions.ts` (+ test: the cap flow), `src/bot/flows.ts`,
  `src/bot/handlers/budget.ts`, `src/bot/handlers/card.ts`, `src/bot/callbackData.ts`,
  `src/bot/keyboards.ts` (the paged category list), `src/bot/messages.ts`.
- **Done when:**
  - Cap `Кафе и рестораны` at `5000`, then record `450 кофе` and `4800 ресторан` in one period:
    category spent `525_000` of cap `500_000`, over by `25_000`. The card's category line uses the
    overspend copy. A `300 такси` card (no cap on transport) has no category line.
  - Every `bud:*` callback_data built in the phase is at most 64 bytes (asserted through
    `assertCallbackData` with the largest category id the regex admits).
  - An archived category's cap isn't listed and doesn't render a card line.

### Phase 5: Budgets on group ledgers
- **Owner skill:** dev
- **What:** The group ledger's settings screen (Plan 0009 Phase 4, owner only) links to the same
  budget screen scoped to that ledger. `/budget` in the bound group posts a read-only budget
  message. Periods and "today" use the ledger's timezone (ADR-0015). Group confirmations stay a
  reaction, with no budget line.
- **Files touched:** `src/bot/group/summary.ts` (or wherever Plan 0009 lands its group
  commands), `src/bot/handlers/settings.ts`, `src/services/budget.ts` (+ test),
  `src/bot/messages.ts`.
- **Done when:** A group ledger in `Europe/Belgrade` has a limit of `30000` (RSD, exponent 2) and
  a group expense `450 кафе` sent at `2026-10-01T22:30:00Z`, which is `2026-10-02 00:30` in
  Belgrade. `budgetStatus` for today `2026-10-02` counts it on day 2, not day 1: today's remainder
  is `193_548 − 45_000 = 148_548`. A non-owner member can't open the ledger's budget setup. The
  callback is refused with the not-owner copy.

### Phase 6: Live check
- **Owner skill:** human
- **Blocks merge:** no
- **What:** The user sets a real payday budget in DM and one in the family group, records for two
  days, and reads the lines.
- **Files touched:** none.
- **Done when:** On day 2, the DM card's "today" figure equals day 2's cumulative share minus
  both days' spending, checked by hand against the `/budget` screen. The group shows no budget
  line on its reactions.

## Data shapes

```sql
-- illustrative: 0008_budgets.sql
CREATE TABLE ledger_budgets (
  ledger_id TEXT PRIMARY KEY REFERENCES ledgers(id),
  limit_minor INTEGER CHECK (limit_minor IS NULL OR limit_minor > 0),
  currency TEXT NOT NULL,              -- ledger default at last set (ADR-0017)
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'optional')),
  period_start_day INTEGER NOT NULL DEFAULT 1 CHECK (period_start_day BETWEEN 1 AND 31),
  updated_at TEXT NOT NULL
);
CREATE TABLE category_caps (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id),
  cap_minor INTEGER NOT NULL CHECK (cap_minor > 0),
  updated_at TEXT NOT NULL
);
-- 0009_category_essential.sql
ALTER TABLE categories ADD COLUMN essential INTEGER NOT NULL DEFAULT 0;
```

```ts
// illustrative
interface BudgetStatus {
  period: { from: LocalDate; to: LocalDate; day: number; days: number };
  currency: CurrencyCode;
  limit?: { limitMinor: number; todayLeftMinor: number; periodLeftMinor: number };
  caps: { categoryId: CategoryId; name: string; spentMinor: number; capMinor: number }[];
  notCounted: ReadonlyMap<CurrencyCode, number>; // other-currency spend in the period
}
```

Callback data: `bud:open`, `bud:lim`, `bud:day`, `bud:scope:<a|o>`, `bud:caps(:p:<page>)?`,
`bud:cap:<categoryId>`, `bud:capx:<categoryId>` (clear), and `cat:ess:<categoryId>:<0|1>`. For
a group ledger, the setup callbacks carry no ledger id. They act on the ledger whose settings
screen is the user's anchor, the same way Plan 0009 Phase 4 scopes its settings.

Illustrative copy (ux-telegram may reword it; it lives in `messages.ts`):
«Осталось на сегодня: 517,74 ₽ · до 31 окт: 29 550 ₽», «Сегодня перерасход 532,26 ₽»,
«Кафе и рестораны: 5 250 из 5 000 ₽».

## Risks & open questions

- **Money.** `L * d` must stay under `Number.MAX_SAFE_INTEGER`. `parseAmount` already rejects
  amounts beyond it, and `d ≤ 31`. The domain function asserts `L * N` is a safe integer and the
  flow rejects larger limits with the existing too-large copy. There's no division outside
  `budget.ts`, and its only rounding is `Math.floor` on non-negative integers.
- **Time.** "Today" is the effective timezone's local date, from the injected clock. A past-dated
  expense (`такси вчера`) counts on its `occurred_on`, so it lowers today's remainder only if it's
  in the current period, which is correct under the cumulative rule.
- **Currency.** A ledger default change after the budget was set leaves the budget in its old
  currency. The `/budget` screen names the budget's currency when it differs from the ledger
  default, and re-setting the limit adopts the new one.
- **Idempotency.** Every write is an absolute set (limit, day, scope, cap, essential), never an
  increment or a toggle, so redelivery and double taps converge.
- **Privacy.** Budget amounts are expense data: debug-level logs only.
- **Product guess.** The five essential presets. It's cheap to change in `categoryPresets.ts`
  before the migration ships, and not after.
- **Dependency.** Phase 5 needs Plan 0009 Phase 4's ledger settings screen. If 0009 isn't closed
  when this plan starts, Phase 5 waits.

## What this plan does NOT do

- **Planned and recurring payments** in the allowance (ZenMoney subtracts them). That needs the
  notifications/scheduler plan named in Plan 0009.
- **Threshold alerts** ("80% of the café cap"), which also need the scheduler.
- **FX conversion** of other-currency spending into the budget (the FX plan, ADR-0003).
- **Income, balances, "free money" and 50/20/30.** The bot records expenses only.
- **Budget history** (last period's result, rollover between periods). Each period starts fresh.
- **Tags/projects and debts:** [Plan 0012](0012-tags-projects.md) and
  [Plan 0013](0013-debts.md).

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton | dev | done | e3c9052 |
| 2: Payday periods | dev | done | c1cfd43 |
| 3: Essential categories | dev | done | db7b104 |
| 4: Per-category caps | dev | done | 111aeaf |
| 5: Group ledgers | dev | done | committed with this row |
| 6: Live check | human | not started | |

### Notes

- Phase 1: no too-large copy existed. The limit flow refuses a limit with `L * 31` past
  `Number.MAX_SAFE_INTEGER` using a new `budgetLimitRefused.tooLarge` line.
- Phase 1: the card and screen copy renders amounts through `formatMoney` («517.74 RSD»), not
  the illustrative «517,74 ₽».
- Phase 1: the budget screen and its setup are owner-only from the start. `/budget` on an
  active ledger the user doesn't own replies `budgetOwnerOnly`.
- Phase 1: the `bot.test.ts` budget tests run in RSD/`Europe/Belgrade`, the harness defaults.
  The plan's RUB/`Europe/Moscow` numbers are asserted in `src/services/budget.test.ts`.
- Phase 1: `/budget` was added to `messages.commands` and to the help text, and
  `💰 Бюджет` to the menu bar. The pinned menu and command-list expectations in `bot.test.ts`
  were updated.
- Phase 2: outside `Files touched`, `src/db/budgets.ts` gained `setBudgetStartDay`, because the
  SQL can only live in `src/db/`. `src/bot/bot.test.ts` had its pinned budget-screen keyboard
  updated and gained a start-day flow test.
- Phase 2: the budget screen shows its period line whenever a budget row exists, including one
  with a start day and no limit.
- Phase 3: outside `Files touched`, `src/db/budgets.ts` gained `setBudgetScope`.
  `src/bot/bot.test.ts` holds the `cat:ess:<id>:1` double-tap test and a `bud:scope:o`
  double-tap test, and had its pinned categories and budget keyboards and budget screen text
  updated.
- Phase 3: the categories screen gets one [Обязательные] button. It opens a paged picker
  (`cat:ess`, `cat:essp:<page>`) where each category's button shows its current value with ✓ and
  carries the opposite one. The scope is two buttons, [Считать все] and [Только необязательные],
  with the current one marked.
- Phase 3: migration 0009 adds `CHECK (essential IN (0, 1))` to the column.
- Phase 4: the paged category list uses `pickerKeyboard`/`pagerRow` from `src/bot/nav.ts`.
  `src/bot/keyboards.ts` was not touched. The cap tests, the 64-byte check and the archived-cap
  test are in `src/bot/bot.test.ts`, outside `Files touched`, and the pinned budget keyboard
  there was updated.
- Phase 4: the 64-byte check uses `Number.MAX_SAFE_INTEGER` (16 digits) as the largest id. A
  16-nines literal is not exactly representable as a number.
- Phase 4: a cap is in the budget's currency. Setting a cap on a ledger without a budget creates
  a budget row with no limit, in the ledger default currency. The clear action is
  [Убрать лимит] on a capped category's prompt (`bud:capx:<id>`). It also clears a pending cap
  flow for that category.
- Phase 4: a cap counts every expense of its category in the budget currency, whatever the
  scope.
- Phase 5: outside `Files touched`, `src/bot/callbackData.ts` gained `SETTINGS_BUDGET`
  (`set:bud`), the scoped hub's [Бюджет] button. The bot tests are in
  `src/bot/group/group.test.ts`.
- Phase 5: the budget screen opened from the group ledger's hub has no [« Назад] to the hub.
  `BudgetScreen` carries no `fromSettings`, because `src/services/flowSessions.ts` is outside
  this phase's files.
- Phase 5: the non-owner refusal is a new toast, `budgetNotOwnerToast`. The plan names the
  "not-owner copy" and none existed for a callback. The bot test reaches it through a settings
  anchor written directly for the member, because `/start gs_` never opens one for a non-owner.
- Phase 5: `/budget` was added to `messages.groupCommands` and to the group help text. In a group
  with no limit and no caps, `/budget` replies with where to set one.

### Close triggers

- **What shipped:**
- **User-visible surface changed:**
- **Gate at the tip:**
- **Outstanding `human` phases:**

## Followups
