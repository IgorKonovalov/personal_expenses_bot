# ADR-0020: An encrypted ledger is sealed to its own public key: recording stays open, reading needs the owner's passphrase

> **Status:** proposed
> **Date:** 2026-10-01
> **Related plan(s):** Plan 0019 ([0019-encrypted-personal-ledger.md](../plans/0019-encrypted-personal-ledger.md))

## Context

The user wants an opt-in mode where a ledger's expenses can be read only by its owner, holding a
key. They named two adversaries: **someone holding a copy of the SQLite file or a backup**, and
**the server operator browsing data at rest**. Other bot users are already kept out by ledger
membership (ADR-0002).

The bot is the computing party, which limits any design. Telegram bot chats are not end-to-end
encrypted, so Telegram sees every message in plaintext. The bot process must read the amount in
"450 кофе" to parse it, and must read amounts to answer "how much this month". So no server-side
design defends against an operator who deploys modified code: it can capture the passphrase at
the next unlock. What a key can guarantee is that the data **at rest** (the database file, its WAL,
and backups) is unreadable without the owner, and that the process holds a readable key only
while the owner has recently unlocked.

Three facts shape the design. All aggregation already happens in TypeScript over repository rows
(`src/domain/aggregate.ts`), not in SQL, so decrypt-then-aggregate reuses the existing code. Node
24 ships X25519, HKDF, AES-256-GCM and `crypto.argon2` in `node:crypto`, so the design adds no
dependency. And the user chose to have background work pause while a ledger is locked, but
recording an expense several times a day must not need an unlock each time.

## Decision

> An encrypted ledger owns an X25519 keypair. The public key is stored in plaintext. Every new
> expense in the ledger is sealed to that public key: amount, description and category go into
> one AES-256-GCM blob, keyed by an ephemeral X25519 exchange and HKDF-SHA256, with
> `ledgerId:expenseId` as associated data. So recording works while the ledger is locked. The
> private key is stored only wrapped (AES-256-GCM) under key-encryption keys: one per member,
> derived from that member's passphrase with Argon2id, and one derived with HKDF from a recovery
> code, which is shown once at setup. `/unlock` unwraps the private key into process memory for
> an idle timeout. Every read of a sealed field needs it. A restart locks every ledger.

What stays plaintext: `occurred_at`, `occurred_on`, `currency`, `created_by`, `source_key` and
the timestamps. Periods are still filtered in SQL before decrypting. An observer at rest learns
how many expenses there were, when, and in which currency, but not what they were or how much.

Encryption is opt-in per ledger and never silently reversed. The key hierarchy (wraps per member)
admits shared ledgers, but Plan 0019 enables it for personal ledgers only.

## Consequences

### Positive
- The database file, its WAL and every backup taken after the switch hold no amount,
  description or category of a sealed ledger. The owner's passphrase or recovery code is the
  only way in.
- Recording ("450 кофе") never needs an unlock, so the everyday path costs nothing.
- No new dependency (`node:crypto` only), and aggregation code is unchanged once the rows are
  decrypted.
- Wraps per member make shared ledgers a later extension, not a redesign.

### Negative
- **No protection against an active operator.** Modified code can capture the passphrase at the
  next `/unlock`. The docs and the bot's enable screen say so.
- **Losing both the passphrase and the recovery code loses the data.** No admin recovery exists,
  by design.
- **Locked means degraded.** Reports, the budget screen, the expense card, edits and category
  changes all answer "locked". Category suggestions from history (ADR-0008) can't use sealed
  history, so a sealed ledger suggests from keyword rules only (Plan 0019 scope).
- **The passphrase passes through Telegram once per unlock.** The user types it in chat, and the
  bot deletes the message at once. It still reaches Telegram's servers and briefly the user's
  devices.
- **Metadata leaks:** expense count, timing and currency stay visible.
- **Old plaintext lingers outside the live file.** Backups taken before the switch keep plaintext
  until rotation drops them. Inside the live file, freed pages need `secure_delete` and a
  `VACUUM` after migration.
- **Sums need the decrypting read path.** Any future SQL that reads amounts directly (a `SUM()`
  in a repository) silently breaks for sealed ledgers. A test must guard that seam.
- `crypto.argon2` is marked release-candidate in Node 24, not stable (unverified against the
  pinned version's changelog). The stored KDF name and parameters let us migrate to `scrypt` or a
  stable API without breaking existing wraps.

## Alternatives considered

### Alternative A: Server key at rest (SQLCipher or field encryption, key in `.env`)
Cheap, and every feature keeps working. Rejected as the answer because the user named the
operator as an adversary, and the operator holds `.env`. It remains a sensible complement against
backup leaks for **unsealed** ledgers, as a separate decision.

### Alternative B: One symmetric ledger key, unlocked per session
AES-256-GCM with a symmetric key wrapped by the passphrase. The crypto is simpler, but nothing can
be **written** while locked, so the owner would unlock several times a day just to record coffee.
The user rejected it for that reason.

### Alternative C: True end-to-end encryption in a Telegram Mini App
The browser encrypts and computes the reports, and the server stores only ciphertext. Rejected:
it is a different product. Typing expenses in chat no longer works (the bot would see the text),
and receipt QR parsing, budgets and summaries would all move to the client.
