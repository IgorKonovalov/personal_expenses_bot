# 0007: Navigation shell: menu, HTML seam, callback dispatcher, and the shipped-UX fixes

> **Status:** in-progress
> **Created:** 2026-09-29
> **Amended:** 2026-09-30: Phase 4's `1.200 JPY` done-when asks, like `1.234` (conductor readiness park)
> **Related ADRs:** [ADR-0011](../adrs/0011-navigation-model.md), [ADR-0012](../adrs/0012-html-rendering-seam.md), [ADR-0004](../adrs/0004-amount-parsing-rule.md)

## TL;DR

The bot gets a persistent menu (`[📊 Сегодня] [❓ Помощь]`), sends every message as escaped HTML,
routes every button through one dispatcher, and fixes what the 2026-09-29 ux-telegram audit
found in the shipped surfaces. The first visible change: `/start` shows the menu bar, and tapping
📊 Сегодня answers like `/today`. The confirmation's button becomes [Удалить], and a deleted
expense can be brought back with [Вернуть]. An ambiguous amount (`1.200 обед`) is answered with
one button per reading instead of "type it again". This plan lands **before** Plan 0003, which
builds on its kit.

## Context & problem

Plans 0003, 0004 and 0005 add pickers, hubs, pagers and text prompts on top of plumbing with
three defects (ux-telegram audit, 2026-09-29, verified against the tree):

- `registerUndo` ends with a catch-all `bot.on('callback_query:data')`
  (`src/bot/handlers/undo.ts:39`). Every callback handler registered after it, which is every
  handler those plans add, is swallowed. Its button spins and does nothing.
- The error boundary answers the callback again after a handler already answered it
  (`src/bot/bot.ts:64`). That second call throws, so the apology is never sent.
- Nothing treats "message is not modified" as success, although Plan 0004 counts on it.

The shipped UX also has holes. A deleted expense can't be restored. «Отменить» (delete) will sit
next to the flows' «Отмена» (abort). An ambiguous amount makes the user retype the line, and a
single-reading question («вы имели в виду 1 234.00 RSD?») can't be answered at all. Editing a
sent message, sending a photo, or typing `/help` gets silence or an accidental reply. There is no
menu, and the user asked for the sibling bot's navigation patterns (ADR-0011) and its HTML
formatting (ADR-0012).

## Decision

Build the parts of ADR-0011 and ADR-0012 that have a consumer today: the menu, the HTML seam,
the callback dispatcher, and card callbacks. The screen-anchor half of ADR-0011 (`requireScreen`,
back and cancel rows) lands with its first consumer, Plan 0003 Phase 3, on ADR-0009's session
row. The list pager lands in Plan 0003 Phase 2 and the period pager in Plan 0004 Phase 2. Code
with no screen to drive it would be untested speculation.

The ambiguous-amount picker is **stateless**. The question is sent as a reply to the user's
message. A tap on `amb:t` or `amb:d` re-parses `callback_query.message.reply_to_message.text` and
records the chosen reading under the **original message's** source key. Double taps, taps on
both readings, and redeliveries therefore record once, by the Plan 0001 rule. We rejected
holding the text in a session row, which would add a flow kind that doesn't wait for text and a
second place for the pending line. We rejected putting the amount in `callback_data`, because
the description can't fit.

## Architecture diagram

```mermaid
flowchart LR
    TG[Telegram update] --> EB[errorBoundary + allowlist]
    subgraph bot["src/bot"]
        EB --> CMD[commands /start /today /help]
        EB --> MENU[menu router: exact label]
        EB --> CBD[callback dispatcher]
        EB --> TXT[text handler: expense]
        EB --> OTH[edited / non-text responder]
        CBD --> CARD[exp:undo / exp:restore]
        CBD --> AMB[amb:t / amb:d]
        CBD --> FB[fallback: answer silently]
        CARD --> R[render/html.ts: replyHtml / editHtml]
        AMB --> R
        TXT --> R
        MENU --> CMD
    end
    subgraph services["src/services"]
        RE[recordExpense] 
        UN[undoExpense / restoreExpense]
    end
    TXT --> RE
    AMB --> RE
    CARD --> UN
```

## Implementation phases

Each phase ships as its own commit. `dev` implements all phases in one session. The architect
reviews once at the end, in a fresh session. The user is in `Europe/Belgrade`, and the ledger
default is RSD.

### Phase 1: Menu bar, /help, and no silent input
- **Owner skill:** dev
- **What:** The persistent menu, exact-match menu routing, `/help`, `setMyCommands` at boot,
  and replies to edited messages, non-text messages and unknown commands. Also the new
  generic-error copy.
- **Files touched:** `src/bot/keyboards.ts`, `src/bot/handlers/menu.ts`,
  `src/bot/handlers/help.ts`, `src/bot/handlers/other.ts`, `src/bot/handlers/start.ts`,
  `src/bot/handlers/today.ts`, `src/bot/bot.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`,
  `src/index.ts`, `README.md` (the menu and `/help`).
- **Done when:**
  - The `/start` and `/help` replies carry a reply keyboard with `is_persistent: true`,
    `resize_keyboard: true` and one row, `📊 Сегодня` / `❓ Помощь`, with labels from
    `messages.menu`.
  - The text `📊 Сегодня` produces a reply identical to `/today`'s and records no expense.
    `❓ Помощь` equals `/help`. `Сегодня` (no emoji) and `📊 Сегодня!` are not menu taps. They
    reach the expense parser and get the help reply, which proves the match is exact.
  - A test runs every `messages.menu` label through `parseExpenseText` with each
    `currencies.ts` default and asserts none parses as `recorded` or `ambiguous`.
  - `/help` replies with the help text, which names the menu buttons. `/foo` gets the same help
    reply and records nothing.
  - A photo, sticker or voice message gets the help reply and writes nothing.
  - An `edited_message` whose source key belongs to a recorded or deleted expense gets
    `messages.editedMessageHint` (`Изменение сообщения не меняет запись. Удалите трату кнопкой
    под подтверждением и отправьте её заново.`). An edit of any other message gets no reply.
    Neither writes anything.
  - `genericError` is `Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не
    записалась.`
  - At boot, `setMyCommands` registers `/today` and `/help`, with descriptions from
    `messages.ts`. If the call fails, one `warn` is logged and boot continues.

### Phase 2: HTML seam (ADR-0012)
- **Owner skill:** dev
- **What:** `render/html.ts` (`Html`, `html`, `joinHtml`, `replyHtml`, `editHtml`). Every
  message text becomes `Html`, every send and edit moves to the helpers, and a lint gate
  enforces it. Amounts in the confirmation and the `/today` header are bold.
- **Files touched:** `src/bot/render/html.ts`, `src/bot/render/html.test.ts`,
  `src/bot/messages.ts`, `src/bot/handlers/*.ts`, `src/bot/bot.ts`, `src/bot/testHarness.ts`,
  `src/bot/bot.test.ts`, `eslint.config.mjs`, `src/lint.test.ts`.
- **Done when:**
  - `` html`a ${'<b>&"'} b` `` equals `a &lt;b&gt;&amp;&quot; b`. `joinHtml` doesn't
    re-escape `Html` parts: `joinHtml([html`${'&'}`, html`<b>x</b>`], '\n')` equals
    `&amp;\n<b>x</b>`.
  - `450 <b>кофе</b> & чай` records the description exactly as typed, and the confirmation is
    sent with `parse_mode: 'HTML'` and the text
    `Записано в «Личные расходы»: <b>450.00 RSD</b> — &lt;b&gt;кофе&lt;/b&gt; &amp; чай`.
  - A description of 300 `<` characters shows 200 `&lt;` followed by `…`. Truncation happened
    before escaping, and no `&lt;` is split.
  - `src/lint.test.ts` runs ESLint's API on in-memory snippets under `src/bot/handlers/`:
    `ctx.reply('x')`, `ctx.editMessageText('x')` and `{ parse_mode: 'HTML' }` each produce an
    error. The same `parse_mode` inside `src/bot/render/html.ts` produces none.
  - `grep -rn "parse_mode" src/bot` matches only `src/bot/render/`.
  - `answerCallbackQuery` toast texts and button labels stay plain strings. A type test assigns
    `messages.undoneToast` to `string`, and `Html`-typed toasts don't compile.

### Phase 3: Callback dispatcher and expense-card actions
- **Owner skill:** dev
- **What:** One dispatcher with a fallback registered last in `bot.ts`, answer-once tracking,
  "not modified" as success, [Удалить] with its copy, [Вернуть] with `restoreExpense`, and the
  deleted card on redelivery.
- **Files touched:** `src/bot/callbacks.ts`, `src/bot/callbackData.ts`,
  `src/bot/handlers/card.ts` (from `undo.ts`), `src/bot/handlers/text.ts`, `src/bot/bot.ts`,
  `src/bot/messages.ts`, `src/services/recordExpense.ts`, `src/services/recordExpense.test.ts`,
  `src/db/expenses.ts`, `src/db/expenses.test.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - A test that registers a handler for a new scope `zz:` **after** every `register*` call in
    `createBot` sees it fire. `qq:1` (no handler) is answered exactly once, with no text and
    no message.
  - A handler that answers its callback and then throws produces exactly one
    `answerCallbackQuery` call and one `genericError` message (the harness counts both).
  - `editHtml` with text and markup identical to the current message resolves without error
    and sends no apology. The harness returns the real 400 description.
  - The confirmation keyboard is one row, [Удалить] `exp:undo:<uuid>` (45 bytes). Copy:
    `undoButton` `Удалить`, `undoneToast` `Трата удалена`, `alreadyUndone` `Эта трата уже
    удалена`, `undoForbidden` `Удалить трату может только тот, кто её записал`, and the card
    text `Удалено из «Личные расходы»: <b>450.00 RSD</b> — кофе`.
  - The deleted card carries [Вернуть] `exp:restore:<uuid>` (48 bytes). A tap clears
    `deleted_at`, toasts `Трата восстановлена`, and edits the card back to the confirmation
    with [Удалить]. `/today` shows the amount again. A second [Вернуть] tap on the same card
    toasts `Трата уже восстановлена` and writes nothing. `restoreExpense` is compare-and-set on
    `deleted_at IS NOT NULL`, author only, and returns `forbidden` for another user (service
    test).
  - Delete, restore, delete leaves one row (`COUNT(*) = 1` for the source key) with
    `deleted_at` set, and `/today` without it.
  - A redelivered `450 кофе` whose expense is deleted replies with the deleted card and
    [Вернуть], not with `Записано…`. It still writes nothing.

### Phase 4: Ambiguous amounts answered with buttons
- **Owner skill:** dev
- **What:** The ambiguous question replies to the user's message with one button per reading
  (`amb:t` thousands, `amb:d` decimal). A tap records that reading under the original message's
  source key and edits the question into the confirmation card.
- **Files touched:** `src/bot/handlers/ambiguous.ts`, `src/bot/handlers/text.ts`,
  `src/bot/callbackData.ts`, `src/bot/messages.ts`, `src/services/recordExpense.ts`,
  `src/services/recordExpense.test.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - `1.200 обед` replies (with `reply_parameters` pointing at the user's message)
    `Сумму можно понять по-разному. Ничего не записано — выберите:` with one row
    [1 200.00 RSD] `amb:t`, [1.20 RSD] `amb:d`.
  - A tap on [1 200.00 RSD] records 120000 RSD `обед` with `source_key` equal to the
    **original** message's key. The question is edited into `Записано в «Личные расходы»:
    <b>1 200.00 RSD</b> — обед` with [Удалить].
  - A second tap on [1 200.00 RSD], or a later tap on [1.20 RSD], records nothing more
    (`COUNT(*) = 1` for that source key) and re-renders the recorded expense's card. The same
    happens when the original message is redelivered after the tap.
  - `1.234 обед` (one reading) replies `Ничего не записано. Вы имели в виду 1 234.00 RSD?` with
    the single button [1 234.00 RSD] `amb:t`. A tap records 123400 RSD.
  - `1.200 JPY обед` is the same one-reading case (ADR-0004: a separator followed by exactly three
    digits is always ambiguous, and `1.2` is invalid at exponent 0, so only the thousands reading
    remains). It replies `Ничего не записано. Вы имели в виду 1 200 JPY?` with the single button
    [1 200 JPY] `amb:t`. A tap records `amount_minor = 1200` in JPY.
  - A tap whose message has no `reply_to_message` (the original was deleted) toasts
    `Исходное сообщение недоступно. Отправьте трату ещё раз.` and records nothing. So does a
    tap whose re-parse no longer offers the tapped reading.
  - No info-level log line contains the amount or the description (pino capture test, as in
    Plan 0001).

## Data shapes

No migration. `expenses.deleted_at` exists since `0001_init.sql`.

```ts
// illustrative, src/bot/render/html.ts
export type Html = string & { readonly __brand: 'html' };
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html;
export function joinHtml(parts: readonly Html[], separator: string): Html;
export function replyHtml(ctx: Context, body: Html, extra?: ReplyOther): Promise<Message>;
export function editHtml(ctx: Context, body: Html, extra?: EditOther): Promise<void>;
```

```ts
// illustrative, src/services/recordExpense.ts
type RestoreExpenseResult =
  | { kind: 'restored'; expense: Expense; ledger: Ledger }
  | { kind: 'alreadyRestored' } | { kind: 'forbidden' } | { kind: 'notFound' };
// recordExpense gains an optional `reading: 'thousands' | 'decimal'` that resolves ambiguity.
```

Callback data added: `exp:restore:<uuid>` (48 bytes), `amb:t`, `amb:d` (5 bytes). The
`messages.menu` labels this plan adds: `📊 Сегодня`, `❓ Помощь`. ADR-0011 has the target
layout.

## Risks & open questions

- **Idempotency:** the ambiguous tap reuses the original message's source key, so every repeat
  path converges on one row. Restore is compare-and-set. A test covers each repeat path listed
  in Phase 4.
- **Telegram:** `callback_query.message` is an `InaccessibleMessage` after 48 hours or when the
  message was deleted. It has no `reply_to_message`, so it takes the toast path.
- **Telegram:** a reply keyboard can't coexist with an inline keyboard on the same message. The
  menu rides on `/start`, `/help` and the help reply only. Telegram keeps showing it after that.
  Confirmations keep their inline card keyboard.
- **Privacy:** the edited-message hint looks up by source key only and logs the user id, never
  the text.
- **Money:** the reading buttons render through `formatMoney`, so the label shows the exact
  minor units that get stored.

## What this plan does NOT do

- Screen anchors, `requireScreen`, back and cancel rows, and flow prompts: Plan 0003 Phase 3,
  per ADR-0011.
- Pagers: Plan 0003 Phase 2 (list) and Plan 0004 Phase 2 (period).
- The `📅 Неделя`, `🗓 Месяц` and `⚙️ Настройки` menu buttons: Plans 0004 and 0005.
- Treating an edited message as an edit of the expense. Plan 0004 adds [Изменить], and its copy
  then points there.
- A list of the day's expenses in `/today`, and moving `/today` onto Plan 0004's summary engine
  (a followup).
- A plural helper. The first count-bearing message brings it.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Menu bar, /help, and no silent input | dev | done | 3dcda85 |
| 2: HTML seam (ADR-0012) | dev | done | ba70d71 |
| 3: Callback dispatcher and expense-card actions | dev | done | committed with this row |
| 4: Ambiguous amounts answered with buttons | dev | not started | |

### Notes

- Phase 1: `src/bot/middleware/allowlist.test.ts` (not in `Files touched`) changed. Its
  pass-through case relied on a location message reaching no handler; it now asserts the help
  reply, and the `/start` case matches with `toMatchObject` because the reply now carries the
  menu.
- Phase 1: the error-boundary test in `bot.test.ts` no longer throws from a `message:location`
  handler added after `createBot` (the non-text responder now consumes it). It closes the
  database and sends `450 synthetic-coffee`.
- Phase 1: `src/bot/handlers/other.ts` imports `findExpenseBySourceKey` from `src/db/` directly
  for the edited-message lookup; no service in `Files touched` exposes it.
- Phase 1: the not-an-expense reply in `text.ts` (outside Phase 1's list) still sent
  `messages.help` without the menu keyboard. Phase 2 moved it to `sendHelp`, which carries the
  menu.
- Phase 1: the menu-label parse test probes every A-Z three-letter code through
  `toCurrencyCode`, since `currencies.ts` exports no roster.
- Phase 2: the ESLint config is `eslint.config.js`, not `eslint.config.mjs` as `Files touched`
  names; the gate went there. It bans `.reply(`, `.editMessageText(` and `.sendMessage(` calls
  and any `parse_mode` property in `src/bot/**` outside `src/bot/render/**`, test files
  included.
- Phase 2: expected payloads in `bot.test.ts` spread `htmlParseMode`, exported from
  `render/html.ts`, so that `parse_mode` is spelled only under `src/bot/render/`.
  `render/html.test.ts` pins it to `{ parse_mode: 'HTML' }`.
- Phase 2: "Html-typed toasts don't compile" is tested as `@ts-expect-error` on assigning
  `messages.undoneToast` / `messages.undoButton` to `Html`. Passing an `Html` value where a
  toast `string` is expected still compiles, because `Html` is a subtype of `string`.
- Phase 2: the `html` tag rejects an interpolated `Html` value at the type level (tested with
  `@ts-expect-error`); `joinHtml` escapes its separator.
- Phase 2: bold went on the confirmation amount, the deleted-card amount and the whole `/today`
  header line. The `/today` per-currency totals are not bold.
- Phase 2: `src/bot/testHarness.ts` needed no change.
- Phase 2: `.prettierrc` (not in `Files touched`) gained `"embeddedLanguageFormatting": "off"`.
  Prettier formats `html`-tagged templates as embedded HTML, which rewrote the message copy
  (line breaks inside `<b>` and the texts).
- Phase 3: the fallback is not a terminal handler registered last. `callbackDispatcher()` in
  `callbacks.ts` is installed after the allowlist. It makes a repeat `answerCallbackQuery` a
  no-op, and once the whole chain has run it answers silently any query nothing answered. A
  terminal catch-all registered last in `createBot` would swallow the `zz:` handler that the
  done-when registers after `createBot`.
- Phase 3: the "not modified" test installs its own API transformer in `bot.test.ts`. It lets
  the harness record the call, then returns Telegram's 400 description for `editMessageText`.
  `testHarness.ts` is unchanged.
- Phase 3: added copy not named in the plan: `restoreButton` `Вернуть` (the plan names the
  label) and `restoreForbidden` `Вернуть трату может только тот, кто её записал`.
- Phase 3: the repository function is `restoreDeletedExpense` in `src/db/expenses.ts`. The
  service is `restoreExpense`.
- Phase 3: `src/bot/render/html.test.ts` (not in Phase 3's list) changed: the toast type test
  pinned the old `Трата отменена` / `Отменить` copy. It now asserts that the texts carry no
  markup characters.

### Close triggers

## Followups
