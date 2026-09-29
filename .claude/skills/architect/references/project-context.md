# Project context: personal expenses bot

Facts the architect needs to ground decisions. **This file does not enumerate ADRs or plans.**
`docs/adrs/README.md` and `docs/plans/README.md` are the live indexes, and a copy here would rot.

## The product

The bot's UI language is **Russian** (owner decision, 2026-09-29).

A Telegram bot for tracking one person's expenses (possibly a household later, which is an open
question for the interview). The core loop:

1. The user sends an expense in free text (`450 coffee`, `12.50 EUR taxi yesterday`) or through
   a guided flow.
2. The bot parses it into amount + currency + category + date, confirms, and offers undo or edit.
3. The user asks for summaries (today, this week, this month, by category) and possibly exports.

Likely later directions, for design awareness only and not commitments: budgets and limits,
recurring expenses, multi-currency conversion, CSV export, reminders to log, shared/household
ledgers.

## Default stack proposal (for ADR-0001)

This is the sibling `traditional-medicine-notifier-bot` stack. It has run in production for months
under a single maintainer, so it is the default unless the interview surfaces a reason to differ.

| Concern | Default | Why it held up |
|---|---|---|
| Runtime | Node 22 (`.nvmrc`, `engines`), TypeScript strict | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` caught real bugs |
| Bot framework | Telegraf, **long polling** | No public TLS endpoint to secure. Webhooks were rejected as not worth it at this scale |
| Storage | better-sqlite3 (WAL, `busy_timeout`), raw SQL in per-concern repositories, no ORM | Single file, trivial backup, synchronous calls keep handlers simple |
| Scheduling | node-cron in-process | Enough for a single instance |
| Logging | pino, structured JSON | |
| Tests | Vitest + real **in-memory SQLite** (no DB mocks) | Mocks hid SQL bugs |
| Lint/format | ESLint flat config, type-aware (`no-floating-promises`, `no-misused-promises`), Prettier | Floating promises in handlers were a real bug class |
| Git hooks | husky + lint-staged (pre-commit: lint-staged + typecheck + test) | husky self-installs via `prepare`. Ritmolux's opt-in `core.hooksPath` hook meant an uninstalled clone silently had no gate |
| Package manager | **pnpm**, pinned via `packageManager` (Corepack) | See supply chain below |
| Deploy | Docker Compose on a small VPS. GitHub Actions: check job (typecheck, lint, build, test), then SSH deploy on push to main | |

**Supply chain** (sibling ADR 016): `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`
(a 7-day cooldown before a new version can be resolved) and `allowBuilds` (install scripts are
denied by default, and only named native deps such as `better-sqlite3` and `esbuild` are allowed).
Direct deps are pinned to exact versions. CI and Docker install with `--frozen-lockfile`.

Open question for ADR-0001: whether to diverge anywhere, e.g. grammY instead of Telegraf (more
actively maintained, better types), or Node's built-in `node:sqlite`. Each is a real alternative
worth recording either way.

## Intended layer layout (confirm in ADR-0001 / the scaffold plan)

```
src/
├── domain/        # pure: money, parsing, categories, aggregation, time windows. No I/O, no framework
├── db/            # connection, migrations, repositories (the only place with SQL)
├── services/      # use-cases orchestrating domain + db (record expense, monthly summary)
├── bot/           # the Telegram adapter: commands, handlers, keyboards, messages module
└── index.ts       # boot: config, db, bot, scheduler
```

Enforce the boundaries with ESLint `no-restricted-imports`, as the sibling does: the bot framework
only under `src/bot/` and `src/index.ts`, no `src/bot/` imports from the domain, and no
`fs`/`process` in `src/domain/`. A boundary written only in prose erodes, and a lint rule holds.

## Lessons carried over from the sibling projects

From **traditional-medicine-notifier-bot**:
- Internal `user_id` PK with the Telegram id in an `auth_identities`-style table. Portability was
  cheap up front and would have been expensive later.
- **Per-user timezone was retrofitted (its ADR 015).** Here it exists from the first schema.
- All user-facing strings live in one `messages` module, in one tone. Handlers never hardcode copy.
- Telegram limits: `callback_data` is at most 64 bytes (guard with an `assertCallbackData`), and
  messages stay under about 4096 chars (use a sanctioned splitter). Callback data uses a
  `<scope>:<action>:<arg>` convention with stable ids, never display text.
- Navigation: one "anchor" message edited in place for multi-step flows, plus a callback prologue
  that validates the session and ignores stale taps. Otherwise each flow reinvents it.
- A post-deploy "what's new" broadcast keyed on `package.json` version, idempotent via a per-user
  `notified_version` watermark. This is worth considering once there are users.
- `.claude/` was gitignored there, and its skills and hooks were lost. Here it is committed.
- **Formatting** (its ADR 011): it started plain-text-only and later needed rich text. The design
  it settled on is `parse_mode` lint-banned outside one render module, a branded `Html` type
  that can only be made by an auto-escaping `html` template, and tag-aware truncation. One
  unescaped `<` or `&` in user text makes Telegram reject the whole message. Decide plain vs.
  HTML by ADR before copy echoes user text in any formatted way.
- **Timezone UX** (its ADR 015): Telegram exposes no timezone, and `language_code` is far too
  coarse. Use a curated city list with index callbacks (`set:tz:<i>`), plus a resolver that
  falls back to the default when the stored zone is corrupt.
- **Deploy** (input for the deploy plan):
  - Liveness is a **heartbeat file** the process touches every 30s. Docker/Compose
    `HEALTHCHECK` fails if it's older than 120s, since a long-polling bot has no HTTP port.
  - **Backups** use better-sqlite3's online `db.backup()` into dated files with rotation, plus
    a best-effort run at boot, written to a host-mounted directory.
  - CI runs `build` as well as `--noEmit`. A `concurrency` group stops overlapping deploys, and
    deploys run on push only.
  - The Dockerfile is multi-stage: prod-only `node_modules`, then `pnpm rebuild better-sqlite3`.
    It runs as the non-root `node` user (uid 1000), and the base image is pinned by digest.
  - Container logs rotate via json-file `max-size`/`max-file`.
  - Graceful shutdown stops the bot, then scheduled jobs and sweepers, then closes the DB.
- **Later plans:**
  - Sends that honour `retry_after` on 429, before any proactive or broadcast messages. With
    grammY that means `@grammyjs/auto-retry`.
  - A per-user rate limiter before open signup (the sibling used 20 updates per 10s, dropping
    callback floods silently).
  - Flow sessions persisted in SQLite, not memory, so a restart doesn't kill a half-done
    multi-step flow.

From **Ritmolux** (harness and process):
- The plan → go → implement → fresh-session review loop, with owner tags per phase and the
  implementation log inside the plan.
- Deny-hooks beat prose rules. Every rule that lived only in prose was eventually broken.
- Index rows are pointers. Its indexes bloated to 16% of the corpus they indexed.
- Moving a plan to `done/` breaks relative links. A checker must run at close.
- The version bump is the most-forgotten close step, so the ceremony decides it every time.
- Written-out counts ("7 categories") go stale. Point at the source.
- Skill files grow by accretion. Before adding a paragraph, ask whether a gate would do.
