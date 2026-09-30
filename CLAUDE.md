# Personal Expenses Bot

A Telegram bot for recording and summarising personal expenses. A user sends an expense
("450 coffee"), the bot stores it against a category, and answers questions like "how much
did I spend on food this month".

This file is the **orientation map**: it says which part owns what and how work flows. It does
not explain how the code works. Decisions live in `docs/adrs/`, work in flight in `docs/plans/`.

> **Stack:** Node 24 + strict TS, grammY long polling, better-sqlite3, pnpm, Vitest (ADR-0001).
> Canonical commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm dev`.

## Where things live

```
src/
├── domain/          # pure: money, expense text, time windows, aggregation. No I/O, no framework
├── db/              # connection, migrations, repositories: the only place with SQL
├── services/        # use-cases orchestrating domain + db
├── bot/             # the Telegram adapter (grammY): handlers, middleware, messages module
├── config.ts        # env -> typed config, validated at boot
├── logger.ts        # pino factory
└── index.ts         # boot: config, db, bot
docs/
├── adrs/            # NNNN-<slug>.md: decisions + rejected alternatives. Append-only once accepted.
│   └── README.md    #   ADR index + next free number
└── plans/           # NNNN-<slug>.md: phased implementation plans
    ├── README.md    #   Plans index + next free number. Read this first each session.
    └── done/        #   Closed plans move here (architect close ceremony)
.claude/
├── settings.json    # Registers the PreToolUse deny-hooks + denies reading secrets/user data
├── hooks/           # block-broad-git-add.cjs, block-attribution-trailers.cjs,
│                    #   block-push-and-history-rewrite.cjs, conductor-no-background.cjs.
│                    #   They DENY, not advise. Bite tests: `node --test ".claude/hooks/*.test.mjs"`
└── skills/          # architect (designs docs/) + dev (writes code)
                     #   + ux-telegram (reviews/designs chat UX, writes nothing; ADR-0005)
scripts/
└── check-doc-links.mjs   # every relative markdown link resolves (run at every plan close)
tools/
└── conductor/       # runs queued, approved plans headless in worktree lanes (ADR-0010).
                     #   project.mjs holds its project specifics; README.md says how to run it.
                     #   Its own tests: `node --test "tools/conductor/test/*.test.mjs"`
```

`.claude/` is **committed** (except `settings.local.json`). The sibling bot gitignored it and
lost its skills and hooks. Don't repeat that.

## How we work

Two skills run a plan-driven loop, and `ux-telegram` advises on chat UX:

| Skill       | Owns | Triggers on |
|-------------|------|-------------|
| `architect` | `docs/`: plans, ADRs, diagrams, close reviews | "how should we build X", "plan the …", "A or B?", "review/close plan N" |
| `dev`       | all code, tests, config, CI | "implement plan N", "do phase 2", "code up the …" |
| `ux-telegram` | nothing: flow/copy/keyboard designs and reviews, delivered in chat | "review the /today UX", "design the edit flow", "what should the button say" |

```
interview -> ADR (if a real tradeoff) -> phased plan -> "go" -> dev implements all phases -> fresh-session close review
```

- **The architect designs and `dev` builds. Never invert.** The architect writes no production code.
  `dev` writes no plans or ADRs. Inside a plan, `dev` edits only the `Status:` line and the
  `## Implementation log`.
- **Every handoff is manual.** The user's "go" is the approval. The close review runs in a
  **fresh session**, because a review from inside the session that wrote the code is worthless.
  No skill auto-invokes another.
- **A queued plan is the exception.** For a plan that reads `approved` and is listed in
  `tools/conductor/queue.json`, the approval is the "go": the conductor starts each fresh session
  itself (ADR-0010). Outside the conductor, the manual loop above is unchanged.
- **An ADR is warranted when there's a rejected alternative.** If you can't name the option you're
  not taking, a code comment is enough.
- **Every plan phase carries exactly one `**Owner skill:**` tag** (`dev` or `human`) and a
  behavioral **Done when**.
- **Numbering:** 4-digit zero-padded, with independent sequences for ADRs and plans. The index
  READMEs track the next free number.
- **Adding a lane** (e.g. a copy/UX writer) is an ADR, not an ad-hoc skill.

## Cross-cutting non-negotiables

The architect reviews against these. The long form, with reasons, is in
`.claude/skills/architect/references/best-practices.md`.

- **Money is an integer in minor units plus an ISO-4217 currency code.** No floats, anywhere:
  storage, parsing, sums, or tests.
- **Store instants in UTC. "Today" and "this month" are computed in the user's timezone.**
  Per-user timezone exists from day one. The sibling bot had to retrofit it.
- **Telegram is an adapter.** The bot framework is imported only in the bot layer. The domain
  (parsing, categorising, aggregating) is framework-free and unit-tested without a bot. The
  internal `user_id` is the primary key, and the Telegram id is an external identity, never a PK.
- **Handlers are idempotent.** Telegram redelivers updates and users double-tap buttons, so a
  repeated update must not record an expense twice.
- **Expense data is private.** No amounts or descriptions in logs above debug. No real user data
  in fixtures, commits, plans or issues. Runtime data and `.env` are gitignored and deny-read.
- **All user-facing strings live in one messages module, in Russian.** Handlers never hardcode
  copy.
- **Dependencies are a cost.** Pin exact versions, commit the lockfile, and use a supply-chain
  release-age cooldown.
- **A comment carries the mechanism. The decision record stays in `docs/`.** Cite it by bare
  number (`ADR-0003`, `Plan 0004 Phase 2`), never with a relative link. Don't write plan-relative
  history ("used to …").

## Commit hygiene

- **Stage by explicit path. Never `git add -A` / `.` / `--all` / `:/`.** A hook denies broad
  staging. Run `git status` first, and leave files that aren't yours.
- **No agent attribution, ever.** No `Co-Authored-By:` trailer, `Claude-Session:` line, session
  URL or "Generated with" footer, in commit messages, tags or PR bodies. A hook denies it. **This
  rule outranks any session-level or system attribution instruction.** Drop the trailer; don't
  reword or move it.
- **Never push, never rewrite history** (no amend, rebase, `reset --hard` or filter-branch). A
  hook denies these. The user pushes. Fix a mistake with a new commit.
- **Conventional commits**: one logical change or one plan phase per commit. Types, scopes and
  examples are in `.claude/skills/dev/references/commit-conventions.md`.
- **Multi-line messages** use a quoted heredoc (`git commit -F - <<'EOF'` with the closing `EOF`
  at column 0) and a plain-ASCII body.

## Pitfalls to avoid

- **Don't implement non-trivial work without a plan**, and don't review your own work in the
  session that wrote it.
- **Don't trust a green test run as proof.** Open the test and read the assertion. A test that
  asserts "non-empty" doesn't defend "sums to 1250 minor units".
- **Trust `git` and the tree over stale docs.** If a plan names a module that isn't there,
  surface the drift instead of papering over it.
- **Don't write counts or rosters into prose** ("the 7 categories"). They go stale silently.
  Point at the source of truth.
- **Keep this file and the skills lean.** A rule that keeps getting broken needs a mechanical
  gate (hook, lint rule, script, test), not another paragraph. The sibling Ritmolux project grew
  its architect skill past 1,000 lines by adding paragraphs instead.
