# ADR-0001: Tech stack: Node 24 + strict TypeScript, grammY long polling, better-sqlite3

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0001](../plans/0001-scaffold-walking-skeleton.md)

## Context

One maintainer builds and runs this project. The sibling `traditional-medicine-notifier-bot`
stack (Node + strict TS, Telegraf long polling, better-sqlite3, pnpm, Vitest, Docker Compose) has
run in production for months, and its lessons are written down in
`.claude/skills/architect/references/project-context.md`. Reusing it is the cheap default.

The roadmap for this bot is heavier than the sibling's. It includes multi-step confirm/edit flows
(receipt → review line items → save), receipt photo handling (QR decoding), file exports (CSV,
XLSX) and optional per-user encryption. The bot framework has to handle sessions and multi-step
conversations well, and the runtime needs `node:crypto` (AES-GCM, scrypt/HKDF) for the encryption
plan.

Node 22 moves into maintenance and reaches end-of-life in April 2027, which is within this
project's first year. Node 24 is the current Active LTS.

## Decision

We build on **Node 24 LTS** (`.nvmrc`, `engines`) with **TypeScript strict**
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). The Telegram adapter is **grammY
using long polling**. Storage is **better-sqlite3** (WAL, `busy_timeout`, `foreign_keys = ON`),
with raw SQL in per-concern repositories and no ORM. Timezone arithmetic uses **`date-fns` +
`@date-fns/tz`**. Logging is **pino**. Tests use **Vitest** against real in-memory SQLite. The
package manager is **pnpm**, pinned via `packageManager`, with a supply-chain cooldown
(`minimumReleaseAge: 10080`, install scripts denied except named native deps) and exact pins.
Lint is ESLint flat config (type-aware) with `no-restricted-imports` layer boundaries, plus
Prettier. Local gates run through husky + lint-staged. Deploy is Docker Compose on a VPS, and it
is designed in its own plan. Everything else follows the sibling defaults in `project-context.md`.

Libraries for later features (QR decoding, image handling, XLSX writing, FX rate source) are
**not** chosen here. Each one is load-bearing, so each gets an ADR with the plan that introduces
it.

## Consequences

### Positive
- The sibling's patterns (anchor message, callback prologue, messages module, deny-by-default
  install scripts) carry over almost unchanged.
- grammY's session and conversation plugins fit the receipt-review and export flows, and its
  context types are precise, which strict TS rewards.
- A single SQLite file is easy to back up, and synchronous calls keep handlers simple. It's
  enough for family scale and a modest open signup.

### Negative
- grammY is a port: the sibling's Telegraf-specific helpers must be rewritten rather than copied.
- better-sqlite3 is a native dependency. It needs `allowBuilds` and prebuilds for Node 24 plus
  the Docker base image. **Unverified:** that a prebuild exists for the exact Node 24 minor at
  scaffold time. Plan 0001 Phase 1 confirms it.
- SQLite limits us to one writer process. Mass open signup at real scale would force a storage
  ADR (Postgres). That is acceptable, because the repository layer confines SQL to `src/db/`.
- `date-fns` + `@date-fns/tz` is two dependencies for what `Temporal` will eventually do
  natively.

## Alternatives considered

### Alternative A: Telegraf (exact sibling stack)
It's proven here, but its development has slowed, its types are looser, and it has no maintained
equivalent of grammY's conversations plugin. It lost because the roadmap is flow-heavy
(receipts, SMS confirmation, exports).

### Alternative B: `node:sqlite` instead of better-sqlite3
It would remove the only native dependency. It lost because in Node 24 it's still pre-stable,
with API churn between minors, and better-sqlite3 is battle-tested in the sibling. Revisit when
`node:sqlite` is stable in an LTS line.

### Alternative C: Python (aiogram) with SQLite
It has a strong OCR/QR ecosystem (pyzbar, OpenCV). It lost because it discards the sibling's
tooling, hooks, lint boundaries and deploy pipeline, and the QR needs are covered by
JS/WASM decoders (to be confirmed in the receipts ADR).

### Alternative D: Luxon for timezone math
It's a single, capable library. It lost to `date-fns` + `@date-fns/tz` on tree-shaking and
because we only need a handful of pure functions (local date of an instant, start/end of a local
day/month).
