# UX patterns

House style for this bot's flows. Where it contradicts an ADR, the ADR wins, so flag the
conflict.

## Recording

- **Free text is the primary entry point.** Commands and buttons exist for things free text
  can't express (summaries, settings, switching ledgers).
- **Save, then confirm with Undo.** Don't confirm first and save after. The confirmation names
  amount + currency, description and ledger.
- The confirmation is also the anchor for follow-ups on that expense (Undo, and later edit,
  category, "move to..."), so those buttons live on it.

## Navigation

- One clear entry per task: free text to record, one command per summary period, one to
  switch ledger, one for settings.
- **Edit in place** for drilldowns (period, then category, then expense list) so the chat
  doesn't fill with stale screens. Keep **one anchor message per flow**. Taps on an older
  message are stale.
- **Keyboard layout:** a primary action gets its own full-width row. Paired actions go two to
  a row. Pagination is one row, `[⬅ Назад] [Вперёд ➡]`. "Назад" sits alone on the bottom row.
  Don't mix navigation and action buttons in one row.
- Every drilldown screen has a way back. A flow never dead-ends on a screen with no buttons
  unless it's finished.

## Multi-step flows and sessions

- Multi-step flows (receipt review, edit, settings wizards) keep their state in the session
  store with a TTL, keyed by internal `user_id`. Clean up on completion, cancel or error.
- **Every multi-step flow has a visible Cancel.** Typing a new expense mid-flow either records
  it normally or is explicitly queued. The design must say which, and never silently swallow it.
- A flow that expired says so in one line and re-offers the entry point.

## Empty, error and ambiguous states

- **Empty:** one friendly line and how to populate it ("Сегодня трат нет. Отправьте, например,
  `450 кофе`.").
- **Ambiguous input:** show the readings and how to resend unambiguously. Never guess.
- **Parse failure:** a short hint with an accepted example, with no blame and no jargon.
- **Unexpected error:** a generic apology from the top-level error boundary. Never a stack
  trace, and never silence.

- **Single-expense deletes use Undo** (soft delete). **Bulk or irreversible actions** (delete a
  ledger, leave a shared ledger, wipe data) require an explicit confirm step.

## Summaries

- Lead with the total(s), then the breakdown. Group per currency until FX exists. Converted
  totals are marked approximate, with the rate date.
- Name the period explicitly with local dates ("Сегодня, 30 сентября"), so a timezone mistake is
  visible.
- Long breakdowns page or collapse into top-N + "more". They don't approach the 4096 limit.

## Notifications (future)

- The bot currently only answers. Any proactive message (reminders to log, budget alerts)
  must be opt-in, easy to switch off from the message itself, and capped. The sibling bot used
  at most 1 proactive push per user per day.

## Tone

- Russian, polite "вы", never "ты". Short, neutral, factual. Money is serious, so no jokes
  about spending and no judgement.
- **No English in the UI chrome** ("OK", "Cancel", "Undo"). Currency codes and the user's own
  descriptions are the only non-Russian text.
- **Plurals follow Russian rules** (1 трата, 2 траты, 5 трат, 21 трата). Use a plural helper
  (`Intl.PluralRules('ru')`) in the messages module, never `трат(ы)`. Counts are digits.
- Emoji only as a consistent marker (for example, one for success and one for warnings), never
  as decoration.
- Same terms everywhere. If it's "ledger" in one message, it's never "book" or "wallet" in
  another.

## Review checklist

The common failures, in rough order of frequency:

1. A hardcoded string outside the messages module, or English leaking into the chrome.
2. A confirmation that omits the currency or the ledger.
3. `callback_data` built from an unbounded id with no length check.
4. A stale button (restart, TTL, not the anchor) that errors or mutates state.
5. A missing `answerCallbackQuery`, so the spinner hangs.
6. A flow prompt that swallows an unrelated expense message.
7. Session state not cleared on success, cancel or error.
8. User text (descriptions) breaking the formatting because it wasn't escaped.
9. A bulk destructive action one tap away without a confirm.
10. Tone drift: "ты", jokes, judgement, or wrong plural forms.
