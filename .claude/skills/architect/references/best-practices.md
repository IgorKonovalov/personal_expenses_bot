# Best practices: personal expenses bot

The correctness rules for this codebase. The architect checks against them in Mode 4, and `dev`
implements against them whether or not a plan restates them. They're ordered roughly by how much
damage a violation does. A rule that turns out wrong for this project is changed by an ADR, not
ignored.

## Money

- **Amounts are integers in minor units, paired with an ISO-4217 currency code.** For example,
  `amount_minor INTEGER NOT NULL, currency TEXT NOT NULL`. Never a JS `number` holding
  `12.5`, never `REAL` in SQL, never `toFixed` for arithmetic.
- **One money module owns parsing, formatting and arithmetic.** Nothing else multiplies, divides
  or rounds amounts. Minor-unit exponents differ by currency (JPY 0, most 2, some 3), so they come
  from a table, not a hardcoded `* 100`.
- **Never sum across currencies without an explicit conversion.** A per-currency total is honest.
  A silently mixed total is a bug. If conversion exists, the rate and its date are stored with
  the converted value.
- **Parsing is strict and locale-aware at the boundary.** `12,50`, `12.50`, `1 200` and `1,200`
  are ambiguous. The rule is decided once (by ADR), tested with a table of cases, and a parse
  failure asks the user rather than guessing.

## Time

- **Store instants as UTC** (ISO-8601 text or epoch ms, decided once). Store the user's IANA
  timezone on the user row from the first migration.
- **Calendar windows are computed in the user's timezone.** "Today", "this month" and "yesterday"
  are all local. A month boundary computed in UTC shows an expense at 00:30 local on the 1st in
  the previous month.
- **Domain code never reads the wall clock.** Inject a clock (`now: () => Date`) so tests pin time.
  Tests around DST transitions and month ends are required whenever window logic changes.
- **An expense's date is what the user meant, not when the message arrived** ("taxi yesterday").
  Keep `occurred_on` (local date) separate from `created_at` (instant).

## Telegram adapter

- **The bot framework is imported only in `src/bot/` and the boot entry**, enforced by ESLint.
  Domain and services depend on interfaces such as a `Notifier`, never on the bot object.
- **Internal `user_id` is the primary key.** The Telegram user id is an external identity, stored
  as TEXT in its own table.
- **Handlers are idempotent.** Telegram redelivers updates after restarts, and users double-tap.
  Dedupe by `update_id` or a per-action token, or make the write naturally idempotent. Recording
  an expense twice is the worst plausible bug in this product.
- **Always answer callback queries**, even stale ones, or the client spins. Stale taps (the
  session has expired, or it's not the anchor message) acknowledge silently and do nothing.
- **Limits:** `callback_data` is at most 64 bytes (assert it). A message is at most 4096 characters
  (split long reports deliberately). User-supplied text is escaped for whatever `parse_mode` the
  render layer uses. Formatting decisions live in one render module, not in handlers.
- **All user-facing copy lives in one messages module**, keyed and parameterised. Handlers never
  build sentences.
- **Every error path answers the user.** A thrown error in a handler is caught by a top-level
  handler that logs it and replies with a generic apology. The bot never goes silent.

## Storage

- **Only `src/db/` contains SQL.** Repositories take and return domain types.
- **Migrations are numbered, forward-only and run at boot.** Never edit an applied migration.
  Add a new one.
- **Soft-delete or an undo window for expenses.** Users mistype, and a hard delete from a button
  tap is unrecoverable.
- **SQLite:** WAL mode, `busy_timeout`, foreign keys on (`PRAGMA foreign_keys = ON` per
  connection), and multi-row writes in a transaction.
- **Backups** of the DB file are part of deploy, not an afterthought. This is the user's
  financial history.

## Privacy and secrets

- **The bot token and any API keys come from the environment only.** `.env` is gitignored and
  deny-read for the agent. `.env.example` documents every variable with a placeholder.
- **Logs carry ids, not content.** No amounts, descriptions or notes above `debug`. No Telegram
  usernames or names in logs.
- **No real user data** in fixtures, tests, plans, issues or commit messages. Fixtures use
  obviously synthetic values.
- **Access control:** if the bot is private, allow-list user ids at the adapter's entry. If it is
  multi-user, every query is scoped by `user_id`, and a test proves one user can't read another's
  expenses.

## Validate at boundaries, trust inside

- User text, callback data, env config and DB rows read back are validated once where they
  enter. Past that point, domain code receives well-typed values and doesn't re-check.
- Config is parsed and validated at boot into a typed object. Fail fast with a clear message
  naming the missing variable.
- **Only the boot entry reads `process.env`.** It hands it to the config parser once, and
  everything else takes the typed config. A stray `process.env.X` skips validation and hides
  the variable from `.env.example`. The sibling stated this rule without a lint gate. Ours should
  get one (`no-restricted-properties` outside `src/index.ts`).

## Tests

- **Test the behavior the plan names**, with the exact values: amounts in minor units, dates in a
  named timezone. `expect(result).toBeDefined()` defends nothing.
- **Real in-memory SQLite** for repository and service tests. No DB mocks.
- The domain is covered by fast pure unit tests. Adapter tests drive handlers with a fake
  context rather than a live bot.

## Dependencies

- **Every dependency is a cost.** Prefer the standard library and small focused packages.
  Justify each new one in the plan, and write an ADR if it is load-bearing (bot framework, DB
  driver, date library).
- Exact pins, a committed lockfile, the release-age cooldown, and install scripts denied by
  default.
