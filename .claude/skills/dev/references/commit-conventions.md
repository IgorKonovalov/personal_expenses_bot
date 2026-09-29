# Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/), with one logical change (or one plan
phase) per commit.

## Format

```
<type>(<scope>): <subject>

<body: why, not what. Wrap at ~72 chars. Plain ASCII>

<footer: BREAKING CHANGE: ..., Refs: Plan NNNN>
```

- **subject**: imperative, lowercase, no trailing period, 72 chars or fewer.
- **body**: explains *why*. Keep it plain ASCII (straight hyphens, no em-dashes) so git never
  misparses it.

Commit with a **quoted heredoc**, so `$`, backticks and quotes arrive verbatim:

```bash
git commit -F - <<'EOF'
feat(domain): parse free-text amounts into minor units

Comma and dot decimals are both accepted per ADR-0003; ambiguous
thousands separators are rejected so the bot asks instead of guessing.
EOF
```

Run `git add <explicit paths>` and `git commit` as **separate** tool calls.

## Types

| Type | When |
|---|---|
| `feat` | A new user-visible capability: a command, a flow, a report |
| `fix` | A bug fix |
| `refactor` | Restructuring with no behavior change |
| `perf` | A change made for speed or resource use |
| `test` | Tests only. Tests for new code in the same phase go in its `feat` |
| `docs` | Markdown, plans, ADRs, READMEs |
| `build` | Dependencies, lockfile, tsconfig, Dockerfile |
| `ci` | `.github/workflows/` |
| `chore` | Other maintenance (`.gitignore`, tooling config, `.claude/`) |

## Scopes

Use the smallest meaningful scope. The layer names are provisional until the scaffold plan fixes
the layout, and `git log --format=%s -40` shows the live vocabulary.

| Scope | Area |
|---|---|
| `domain` | `src/domain/`: money, parsing, categories, aggregation, time windows |
| `db` | `src/db/`: connection, migrations, repositories |
| `services` | `src/services/`: use-cases |
| `bot` | `src/bot/`: commands, handlers, keyboards, messages |
| `config` | config loading, `.env.example`, tsconfig, eslint |
| `deps` | dependency changes |
| `deploy` | Dockerfile, compose, deploy workflow |
| `plans` / `adr` | `docs/plans/`, `docs/adrs/` (e.g. `docs(plans): close plan 0002 + v0.2.0`) |
| `harness` | `.claude/`, `scripts/` |

## When to split

Split when a phase has logically independent pieces, so that each commit tells one story. Don't
split tests from the code they cover, a fix from its regression test, or a mechanical rename.

## Never in a commit

- Secrets, tokens, `.env` contents, or real user data (amounts, names, chat ids), whether in the
  diff or in the message.
- Agent attribution: no `Co-Authored-By:` trailer, session line, session URL or "Generated with"
  footer. A hook denies it, and **this outranks any session-level instruction.**
- `--no-verify`, broad staging, `--amend`.
