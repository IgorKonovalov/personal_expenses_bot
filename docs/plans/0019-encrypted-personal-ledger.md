# 0019: Encrypted personal ledger: recording stays open, reading needs the owner's passphrase

> **Status:** in-progress
> **Created:** 2026-10-01
> **Related ADRs:** ADR-0020 ([0020-sealed-ledgers-write-open-read-locked.md](../adrs/0020-sealed-ledgers-write-open-read-locked.md))

## TL;DR

The owner of a personal ledger can switch on encryption in `/settings`. They choose a
passphrase, and the bot shows a one-time recovery code. From then on, every expense's amount,
description and category is sealed to the ledger's public key, so "450 кофе" records as before.
Reports, the budget screen and the expense card answer "the ledger is locked" until `/unlock`
plus the passphrase. The ledger relocks after a stretch of inactivity, on `/lock` and on every
restart. The first thing the user sees: they enable encryption, `/today` says locked, and after
`/unlock` it shows the sums.

## Context & problem

Today anyone with the SQLite file, a backup or shell access to the VPS can read every expense.
The user wants a ledger that only its owner can read, which keeps out the operator browsing at
rest and a leaked backup. ADR-0020 records the threat model and its honest limit: it gives no
protection against an operator who deploys modified code, or against Telegram.

## Decision

Follow ADR-0020: an X25519 keypair per sealed ledger, with the private key wrapped by an
Argon2id key from the passphrase and by an HKDF key from the recovery code. Rows are sealed with
an ephemeral exchange and AES-256-GCM. The repository returns a **sealed variant** of the expense
type, so the compiler forces every reader through the decrypting seam. Personal ledgers only.

We rejected a server key in `.env` because the operator holds `.env`. We rejected a symmetric
session key because recording would need an unlock several times a day. We rejected a Mini App
with true end-to-end encryption because it means a different product.

## Architecture diagram

```mermaid
flowchart LR
    subgraph Telegram
      U[owner]
    end
    subgraph bot[bot adapter]
      H[text / summary / card handlers]
      UL[unlock flow: deletes the passphrase message]
    end
    subgraph services
      R[recordExpense: seal to public key]
      O[openExpenses: decrypt or Locked]
      K[ledgerKeys: in-memory private keys, idle timeout]
    end
    subgraph domain
      S[sealing: X25519 + HKDF + AES-GCM, Argon2id wrap]
      A[aggregate: unchanged]
    end
    subgraph db
      E[(expenses.sealed BLOB)]
      W[(ledger_keys + ledger_key_wraps)]
    end
    U --> H --> R --> S --> E
    U --> UL --> K --> W
    H --> O --> K
    O --> E
    O --> A
```

## Implementation phases

Each phase ships as its own commit. `dev` implements all phases in one session with no review
between phases. The architect reviews once at the end, in a fresh session.

### Phase 1: Walking skeleton: enable, seal new expenses, `/today` locked and unlocked
- **Owner skill:** dev
- **What:**
  - `src/domain/sealing.ts` holds the pure crypto on `node:crypto`: keypair generation, seal and
    open with associated data, Argon2id and HKDF key derivation, and wrap and unwrap.
  - Migration `0011` adds `ledger_keys` and `ledger_key_wraps` (Data shapes), and rebuilds
    `expenses` so that a sealed row holds `sealed` with `amount_minor`, `description`,
    `category_id` and `description_key` NULL.
  - `/settings` on a personal ledger gets an «Шифрование» entry. The enable flow asks for a
    passphrase of at least 10 characters and deletes the user's message. It shows the recovery
    code with a «Сохранил» button, and deletes the code message when the user taps it.
  - `recordExpense` seals when the ledger has a key. `/today` answers locked or decrypts.
  - `/unlock` asks for the passphrase and deletes the user's message. Enabling is refused on a
    ledger that already has expenses (Phase 3 lifts this).
- **Files touched:** `src/domain/sealing.ts` (+ test), `src/db/migrations/0011_sealed_ledgers.sql`,
  `src/db/ledgerKeys.ts` (+ test), `src/db/expenses.ts`, `src/services/ledgerKeys.ts` (+ test),
  `src/services/recordExpense.ts`, `src/services/todaySummary.ts`, `src/services/settings.ts`,
  `src/services/flowSessions.ts`, `src/bot/flows.ts`, `src/bot/handlers/settings.ts`,
  `src/bot/handlers/today.ts`, a new `src/bot/handlers/unlock.ts`, `src/bot/handlers/menu.ts`,
  `src/bot/bot.ts`, `src/bot/messages.ts`.
- **Done when:**
  - `open(seal(pub, p, aad), priv, aad)` returns `p`. Flipping any byte of the blob, or opening
    with a different `aad`, throws. A wrap made with passphrase X does not unwrap with X + "!".
  - In a bot-harness test: enable with passphrase `correct horse 42`, record `450 кофе` and
    `1200 такси`. The stored rows have `amount_minor IS NULL` and `description IS NULL`, and the
    DB bytes contain neither `кофе` nor `такси`. `/today` replies with the locked message. After
    `/unlock` + the passphrase, `/today` totals 1650 (minor units 165000 when the ledger default
    is a two-decimal currency). The update that carried the passphrase triggers a `deleteMessage`
    for that message id.
  - A wrong passphrase replies with the wrong-passphrase message and leaves the ledger locked.

### Phase 2: Every read path honors the lock
- **Owner skill:** dev
- **What:**
  - The expense read functions in `src/db/expenses.ts` return `StoredExpense = Expense |
    SealedExpense`, and the read functions in `src/db/receipts.ts` that join expense fields do
    the same. A single `openExpenses` service turns rows into `Expense` or a `Locked` result.
  - Every caller is fixed until `pnpm typecheck` passes: `/week`, `/month`, the budget screen,
    the expense card, edit, change category, delete and restore.
  - Edits and category changes re-seal the whole payload.
  - A sealed ledger skips `findHistoryCategory` and suggests from keyword rules only (ADR-0008
    fallback).
  - A receipt QR photo or link sent into a sealed ledger is refused with its own message. Nothing
    is recorded.
- **Files touched:** `src/db/expenses.ts`, `src/db/receipts.ts`, `src/services/periodSummary.ts`,
  `src/services/budget.ts`, `src/services/editExpense.ts`, `src/services/changeCategory.ts`,
  `src/services/recordExpense.ts`, `src/services/recordReceipt.ts`, `src/bot/handlers/summary.ts`,
  `src/bot/handlers/budget.ts`, `src/bot/handlers/card.ts`, `src/bot/handlers/edit.ts`,
  `src/bot/handlers/category.ts`, `src/bot/handlers/receipt.ts`, `src/bot/screens.ts`,
  `src/bot/messages.ts`, and their tests.
- **Done when:**
  - While locked, `/week`, `/month`, the budget screen and tapping an existing card each reply
    with the locked message, and none of them throws.
  - While unlocked, editing `450 кофе` to `500` leaves a sealed row that opens to
    `amountMinor: 50000` (a two-decimal currency), still with a NULL plaintext `amount_minor`.
  - On a sealed ledger, `/month` with expenses 450 + 1200 + 300 in the period totals 1950.
  - Recording `кофе 300` twice in a sealed ledger never reads `description_key` (asserted on the
    repository call, not on the copy).
  - A receipt link sent to a sealed ledger leaves the `expenses` and `receipts` row counts
    unchanged.

### Phase 3: Enable on a ledger with history
- **Owner skill:** dev
- **What:**
  - Enabling seals every existing expense of the ledger in one transaction. For an expense with a
    fetched receipt, `seller_name`, `verify_url` and its `receipt_items` fold into the sealed
    payload, and the `receipts` and `receipt_items` rows are deleted.
  - Enabling is refused while any receipt of the ledger is `pending`.
  - After the transaction: `PRAGMA secure_delete = ON` (set at connection open),
    `wal_checkpoint(TRUNCATE)` and `VACUUM`.
  - The enable confirmation says that backups taken before today keep plaintext until rotation
    drops them.
- **Files touched:** `src/services/sealLedger.ts` (+ test), `src/db/expenses.ts`,
  `src/db/receipts.ts`, `src/db/connection.ts`, `src/bot/handlers/card.ts`, `src/bot/messages.ts`.
- **Done when:**
  - A ledger with 3 expenses (one of them a fetched receipt with 2 items) is enabled. All 3 rows
    are sealed, and `receipts` and `receipt_items` have 0 rows for the ledger. After the file is
    closed, the bytes of the DB file and its `-wal` contain none of the 3 descriptions nor the
    seller name. Once unlocked, the receipt expense's card lists both items.
  - With one `pending` receipt, enabling is refused and every row stays plaintext.
  - A failure injected midway leaves every row plaintext and no `ledger_keys` row.

### Phase 4: Recovery code and passphrase change
- **Owner skill:** dev
- **What:**
  - `/recover` takes the recovery code (case-insensitive, separators ignored) and a new
    passphrase, replaces the owner's passphrase wrap, and keeps the recovery wrap.
  - While unlocked, `/settings` → «Шифрование» → «Сменить пароль» replaces the passphrase wrap.
  - Every message that carries a secret is deleted.
- **Files touched:** `src/services/ledgerKeys.ts`, `src/db/ledgerKeys.ts`, `src/bot/handlers/unlock.ts`,
  `src/bot/handlers/settings.ts`, `src/bot/flows.ts`, `src/services/flowSessions.ts`,
  `src/bot/bot.ts`, `src/bot/messages.ts`, and their tests.
- **Done when:**
  - After `/recover` with the right code and new passphrase Y, `/unlock` Y opens, and the old
    passphrase X is refused.
  - A wrong recovery code changes nothing. The recovery code is 160 random bits, shown as 8
    groups of 4 base32 characters.
  - After a passphrase change, existing sealed rows still open, because the ledger keypair is
    unchanged.

### Phase 5: Lock lifecycle, log hygiene, docs
- **Owner skill:** dev
- **What:**
  - The unlocked key expires after 30 minutes without a read of that ledger, measured with an
    injected clock. Each read slides the expiry.
  - `/lock` locks now. A restart starts with every ledger locked.
  - A test asserts that no passphrase or recovery code reaches the logger at any level,
    including `debug`.
  - `/help`, `README.md` and `CLAUDE.md`'s "Where things live" (if `sealing.ts` warrants a line)
    are updated. The enable screen states the limit (it doesn't protect against the operator
    changing the code, or against Telegram).
- **Files touched:** `src/services/ledgerKeys.ts` (+ test), `src/bot/handlers/unlock.ts`,
  `src/bot/handlers/help.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`, `README.md`.
- **Done when:**
  - Two separate runs, each starting with an unlock at 12:00 and a `/today` at 12:10. In the
    first, a `/today` at 12:39 succeeds. In the second, a `/today` at 12:41 says locked, because
    the 12:10 read slid the expiry to 12:40 and the 12:39 read doesn't happen in this run.
  - After `/lock`, `/today` replies locked.
  - A fresh `ledgerKeys` service over the same DB starts locked.
  - Running the enable, unlock and recover flows with a pino destination at `level: 'trace'`
    captures no line containing the passphrase or the recovery code.

### Phase 6: Live check in Telegram
- **Owner skill:** human
- **What:** On the deployed bot, with a throwaway personal ledger (a second Telegram account),
  enable encryption, record 2 expenses, `/today` locked, `/unlock`, `/today`, `/lock`, `/recover`.
  Confirm that the passphrase and recovery-code messages disappear from the chat on both the
  phone and the desktop client.
- **Files touched:** none.
- **Done when:** The user has run the sequence and reports each step as behaving as described.

## Data shapes

```sql
-- illustrative
CREATE TABLE ledger_keys (
  ledger_id TEXT PRIMARY KEY REFERENCES ledgers(id),
  public_key BLOB NOT NULL,          -- raw X25519, 32 bytes
  created_at TEXT NOT NULL
);
CREATE TABLE ledger_key_wraps (
  ledger_id TEXT NOT NULL REFERENCES ledger_keys(ledger_id),
  wrapper TEXT NOT NULL CHECK (wrapper IN ('member', 'recovery')),
  user_id TEXT REFERENCES users(id),  -- NULL for 'recovery'
  kdf TEXT NOT NULL,                  -- 'argon2id' | 'hkdf-sha256'
  kdf_params TEXT NOT NULL,           -- JSON: salt, memory, passes, parallelism
  wrapped_private BLOB NOT NULL,      -- nonce || AES-256-GCM(ciphertext || tag)
  UNIQUE (ledger_id, wrapper, user_id)
);
-- expenses (rebuilt): amount_minor, description nullable; new `sealed BLOB`;
-- CHECK ((sealed IS NULL) = (amount_minor IS NOT NULL))
```

```ts
// illustrative
// sealed blob: version(1) || ephemeralPub(32) || nonce(12) || ciphertext || tag(16)
// aad: `${ledgerId}:${expenseId}`
interface SealedPayloadV1 {
  v: 1;
  amountMinor: number; // integer
  description: string;
  categoryId: number | null;
  receipt?: { sellerName: string | null; verifyUrl: string; items: { name: string; quantity: string; totalMinor: number }[] };
}
type StoredExpense = Expense | SealedExpense; // SealedExpense has no amount/description fields
```

Argon2id parameters: 64 MiB memory, 3 passes, parallelism 1, with a 16-byte random salt. They
are stored per wrap, so they can change later without a migration.

## Risks & open questions

- **A third record path.** [Plan 0021](done/0021-bank-sms-card-purchase.md) adds `recordBankSms`
  (`src/services/recordBankSms.ts`) next to `recordExpense` and `recordReceipt`. Whichever plan
  lands second routes it through the sealing seam. Its `sms:` source key is a hash of the
  purchase's time, amount and merchant, which is low-entropy (ADR-0021, Negative).
- **Converted totals.** [Plan 0022](done/0022-converted-totals-nbs.md) adds a migration and edits
  `periodSummary.ts`, `todaySummary.ts` and `budget.ts`. Whichever plan lands second takes the next
  free migration number and rebases onto the other's service shape. Conversion runs on opened
  expenses, after decryption.
- **Rebuilding the `expenses` table.** SQLite can't relax `NOT NULL` with `ALTER`, so migration
  `0011` rebuilds the table. `receipts.expense_id` references it, and the indexes must be
  recreated. Check how `migrate.ts` handles `foreign_keys` during the copy.
- **Money:** the sealed payload carries `amountMinor` as an integer. A test asserts that a
  decrypted payload with a non-integer amount is rejected, not rounded.
- **Idempotency:** `source_key` stays plaintext and unique, so redelivery dedupe is unchanged. An
  enable or unlock flow that gets redelivered must not create a second keypair or wrap. The
  `ledger_keys` primary key makes the second insert fail, and the service treats that as already
  done.
- **Privacy:** flow-session payloads must not carry the passphrase between steps. The secret is
  consumed in the update that carries it. Check that no flow payload holds an expense amount or
  description for a sealed ledger.
- **Memory:** an unlocked private key sits in process memory, and a core dump or swap could
  expose it. We accept this under ADR-0020's threat model.
- **Open (product call, default chosen):** Phase 2 refuses new receipt QRs in a sealed ledger,
  while Phase 3 seals the receipts that already exist. The alternative is to record the QR total
  sealed now and fetch the line items while unlocked, in the followup below.
- **Open:** a 30-minute idle timeout, a 10-character minimum passphrase. Both are guesses, and
  each is a single constant.

## What this plan does NOT do

- Shared or group ledgers. The wraps per member support them, and they get their own plan.
- Switching encryption off (decrypt back to plaintext).
- New receipts in a sealed ledger, and fetching line items while unlocked (followup plan).
- Category suggestion from sealed history while unlocked (followup: an in-memory index built at
  unlock).
- Encrypting unsealed ledgers or backups with a server key (ADR-0020, Alternative A, as its own
  decision).
- Purging old backups. Rotation (`BACKUP_KEEP`) drops them on its own schedule.

## Implementation log

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton | dev | done | `75f84e2` |
| 2: Every read path honors the lock | dev | done | `c1b5093` |
| 3: Enable on a ledger with history | dev | done | `4cf2062` |
| 4: Recovery code and passphrase change | dev | done | `1f38257` |
| 5: Lock lifecycle, log hygiene, docs | dev | done | `c88efce` |
| 6: Live check in Telegram | human | pending | (no commit) |

### Notes

- Phase 1: the migration is `0012_sealed_ledgers.sql`; `0011` is `fx_rates` (Plan 0022). The
  rebuild runs with `foreign_keys` ON inside the runner's transaction, so `receipts` and
  `receipt_items` are copied to temp tables, deleted, and put back after the swap. `migrate.ts`
  is unchanged. Two partial unique indexes keep one member wrap per user and one recovery wrap
  per ledger, since `UNIQUE (ledger_id, wrapper, user_id)` treats NULL user ids as distinct.
- Phase 1: files outside `Files touched`: `src/index.ts` and `src/bot/testHarness.ts` create the
  one keyring and pass it to `createBot` and the receipt worker (`HandlerDeps.keys`);
  `src/bot/callbackData.ts` gains `set:enc` and `enc:saved`; `src/bot/handlers/text.ts` replies
  to the new `sealedDuplicate` result; `bot.test.ts`, `receiptWorker.test.ts`,
  `screens.test.ts` and `todaySummary.test.ts` pass a keyring, and the settings hub keyboard in
  `bot.test.ts` gains the «Шифрование» row. The bot-harness test is a new
  `src/bot/handlers/unlock.test.ts`.
- Phase 1: done ahead of its phase: the history step is skipped for a sealed ledger (Phase 2),
  and the recovery code's generation and base32 format (Phase 4), since enable shows it.
- Phase 1: `recordExpense` takes the keyring as optional; without one a sealed row reads as
  locked. A redelivered expense of a locked sealed ledger returns `sealedDuplicate` and gets its
  own reply.
- Phase 1: enabling leaves the ledger locked. `/unlock` takes one attempt per prompt: a wrong
  passphrase answers the flow, so the next text is never taken as a passphrase. The passphrase
  prompts take any text, including expense-shaped text, since `correct horse 42` parses as an
  expense.
- Phase 1: `/unlock` is not in the `setMyCommands` list yet; `bot.test.ts` pins that list, and
  Phase 5 owns the help and command copy.
- Phase 2: the decrypting seam is `openExpenses` / `openExpense` in `src/services/ledgerKeys.ts`;
  services check ownership and membership on the stored row before opening it. A locked read
  returns `{ kind: 'locked' }`. While locked, card taps (category, edit, delete, restore, back)
  answer with the `ledgerLockedToast` toast; `/week`, `/month` and `/budget` reply with
  `ledgerLocked`, and the budget screen, opened from the hub or redrawn after a flow, shows that
  message alone.
- Phase 2: files outside `Files touched`: `src/services/recordBankSms.ts` records through the
  shared `storeExpense` (Risks: a third record path); `src/services/fetchDueReceipt.ts` and
  `src/bot/group/card.ts` take rows through `plaintext()`, which throws on a sealed row (receipts
  and shared ledgers are never sealed); `src/bot/handlers/text.ts` replies to a sealed duplicate
  bank SMS; `src/bot/flows.ts` skips a locked budget redraw. The keyring is added to the deps
  of `budget`, `changeCategory`, `editExpense`, `periodSummary`, `recordBankSms` and
  `recordExpense` tests and of `group.test.ts`. A test helper `src/services/testing/sealLedger.ts`
  seals and unlocks a personal ledger through the real flows.
- Phase 2: `src/db/receipts.ts` and `src/bot/screens.ts` are unchanged: no receipt reader runs on
  a sealed ledger's expenses.
- Phase 2: the done-when's `кофе 300` is not an expense to the parser (the amount comes first);
  the test records `300 кофе`. The history-step assertion spies on `findHistoryCategory` with
  `vi.mock` and checks it is called in a plaintext ledger and not in a sealed one.
- Phase 2: a receipt in a sealed ledger is refused before the duplicate lookup, with
  `receiptSealedLedger`.
- Phase 3: files outside `Files touched`: `src/services/ledgerKeys.ts` calls `sealLedgerRows`
  inside the enable transaction and `scrubFreedPages` after it, replaces the `hasExpenses`
  refusal with `pendingReceipts`, and gains `foldedReceipt`; `src/bot/handlers/unlock.ts`
  replies to `pendingReceipts`; `src/services/fetchDueReceipt.ts` reads a sealed row's items
  from its payload in `receiptItems` and answers `notFound` to [Повторить] on a sealed row;
  `src/bot/handlers/receipt.ts` answers [Позиции] on a locked ledger with the locked toast.
  `connection.test.ts`, `ledgerKeys.test.ts` and `unlock.test.ts` gain assertions.
- Phase 3: a `failed` receipt folds in too, with its link and a NULL seller; its card then shows
  no receipt line and no [Повторить].
- Phase 3: the done-when's "card lists both items" is asserted on `receiptItems` (the [Позиции]
  service), not on a bot tap. The card's receipt line for a sealed row comes from the folded
  payload in `cardView`.
- Phase 3: the backup sentence is in the recovery code message, which only enabling sends.
- Phase 3: `scrubFreedPages` checkpoints with TRUNCATE before and after `VACUUM`. With the scrub
  and `secure_delete` taken out, the file-bytes test fails.
- Phase 4: a right recovery code unlocks the ledger and starts a second prompt
  (`recoverPassphrase`) for the new passphrase, so no flow payload carries the code. Leaving
  after the code leaves the ledger unlocked and every wrap unchanged. `/recover` takes one
  attempt per prompt, like `/unlock`.
- Phase 4: files outside `Files touched`: `src/bot/callbackData.ts` gains `set:encpw`
  ([Сменить пароль]). `src/bot/bot.ts` and `src/bot/flows.ts` are unchanged: `/recover` is
  registered in `registerUnlock`, and the new secret flows reach `answerSecretFlow` through
  `isSecretFlow`.
- Phase 5: `createLedgerKeyring` takes the clock the idle expiry runs on, so `src/index.ts`,
  `src/bot/testHarness.ts` and every test fixture with a keyring pass one (outside `Files
  touched`). `privateKey` slides the expiry; a new `isUnlocked` answers status checks (the
  settings screen, `/unlock`, the budget screen's lock check) without sliding it. An expiry is
  reached at exactly 30 minutes.
- Phase 5: the 12:00 / 12:10 / 12:39 / 12:41 runs are service tests on `todaySummary` (what
  `/today` calls) with a movable clock, in `ledgerKeys.test.ts`. `/lock` and the log test are
  bot-level in `bot.test.ts`. The log test also records, reads and locks, and checks the code in
  its shown, dash-less and lower-case forms. With a trace log of the passphrase added to
  `unlockLedger`, it fails.
- Phase 5: `/unlock` and `/lock` join the `setMyCommands` list (its pinned test in `bot.test.ts`
  is updated), and the `/settings` description names encryption. `/recover` is in `/help` only.
  `src/bot/handlers/help.ts` is unchanged: the copy lives in `messages.help`. `CLAUDE.md`'s
  `src/domain/` line gains "sealing".
- Followup (not acted on): a tap on an ambiguous-amount reading whose expense is already in a
  locked sealed ledger answers `ambiguousSourceUnavailable`, since `recordExpense` returns
  `sealedDuplicate` and `src/bot/handlers/ambiguous.ts` treats any non-`recorded` result alike.
- Followup (not acted on): README's Roadmap still names an encrypted personal ledger among the
  active plans.
- Fix (review minor: a failing post-seal scrub lost the recovery code): `enableEncryption`
  logs a scrub failure with ids and still returns the code. `811d2c1`.
- Fix (review minor: a secret sent after its prompt expired): the first text within the
  24-hour reply window after an expired secret prompt routes as `expiredSecret`. It is deleted
  unread, the prompt is dropped, and `secretPromptExpired` asks to resend an expense. `9c630e2`.
- Fix (review major: content-derived source keys on sealed rows): in a sealed ledger
  `recordBankSms` keys the row by the Telegram message (`messageKey`, passed by the text
  handler); `sealLedgerRows` re-keys the ledger's `sms:` and `rcpt:` rows to `sealed:<expenseId>`
  inside the enable transaction (`rekeyContentSourceKeys` in `src/db/expenses.ts`). README states
  the second-paste behavior. The sealed-ledger SMS done-whens are service tests in
  `recordBankSms.test.ts`; the handler passes the key it builds for typed text. `74d3cb6`.
- Fix (review minor: no guard on SQL sums over amounts): `src/db/noAmountAggregates.test.ts`
  fails when any non-test source under `src/db/`, migrations included, aggregates
  `amount_minor`. `e8a751d`.
- Fix (review nit: the engines floor): `package.json` engines reads `>=24.7.0 <25`, the first
  Node with `crypto.argon2`. `.nvmrc` (`24`) and the Docker base (`node:24-alpine` by digest) are
  unchanged. `52cc236`.
- Fix (review minor: a secret typed as a command argument): `/unlock` and `/recover` with text
  after the command delete that message unread, then prompt as before; the argument is ignored.
  Committed with this line.

### Close triggers

- **What shipped:** migration `0012_sealed_ledgers.sql` (`ledger_keys`, `ledger_key_wraps`, the
  rebuilt `expenses` with a nullable plaintext and a `sealed` BLOB); `src/domain/sealing.ts`
  (X25519 + HKDF-SHA256 + AES-256-GCM seal and open, Argon2id and HKDF wraps, the base32 recovery
  code, the v1 payload codec); `src/db/ledgerKeys.ts`; `src/services/ledgerKeys.ts` (the keyring
  with its idle expiry, enable, unlock, recover, passphrase change, lock, `openExpenses` /
  `openExpense`, `resealed`, `foldedReceipt`); `src/services/sealLedger.ts` (sealing a ledger's
  history, `scrubFreedPages`); `src/bot/handlers/unlock.ts`; `StoredExpense = Expense |
  SealedExpense` from every expense reader in `src/db/expenses.ts`; `storeExpense` and
  `historyCategory` in `src/services/recordExpense.ts`; `secure_delete = ON` at connection open;
  `HandlerDeps.keys`, one keyring per process created in `src/index.ts`. No new dependency
  (`node:crypto` only).
- **User-visible surface changed:** `/settings` gains [Шифрование] (the enable prompt with its
  limits, then the state, with [Сменить пароль] while unlocked). New commands `/unlock`, `/lock`
  (both in the command list) and `/recover`. The recovery code message with [Сохранил]. In a
  sealed ledger: `/today`, `/week`, `/month`, `/budget` and card taps answer locked until
  `/unlock`; receipts are refused; categories come from keywords only; passphrase and code
  messages are deleted. `/help` has one new line, its menu line names encryption. README has an
  `### Encrypted ledger` section. Existing databases go through the `expenses` rebuild at boot.
- **Gate at the tip:** `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0, 70 files,
  981 tests (after the third fix pass); `pnpm build` exit 0 (`dist/db/migrations` holds `0012_sealed_ledgers.sql`);
  `node --test "tools/conductor/test/*.test.mjs"` exit 0, 236 tests;
  `node --test ".claude/hooks/*.test.mjs"` exit 0, 31 tests; `node scripts/check-doc-links.mjs`
  exit 0, 240 links.
- **Outstanding `human` phases:** Phase 6 (the live check in Telegram with a throwaway personal
  ledger).

## Followups
