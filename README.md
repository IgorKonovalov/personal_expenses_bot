# Personal Expenses Bot

A Telegram bot for recording and summarising personal expenses. Send `450 coffee`, and it is
recorded in your active ledger. `/today` shows today's totals per currency.

Orientation for contributors (and agents) is in [CLAUDE.md](CLAUDE.md). Decisions are in
[docs/adrs/](docs/adrs/README.md), and work in flight is in [docs/plans/](docs/plans/README.md).

## Requirements

- Node 24 (`.nvmrc`)
- pnpm, the version pinned in `package.json` `packageManager` (Corepack or mise)

## Setup

```sh
pnpm install            # also installs the husky pre-commit hook
cp .env.example .env    # then fill in BOT_TOKEN and ALLOWED_TELEGRAM_IDS
pnpm dev                # long polling, restarts on change
```

Every variable is documented in [.env.example](.env.example).

## Checks

| Command | What |
|---|---|
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm lint` | ESLint (type-aware), including the layer-boundary rules |
| `pnpm test` | Vitest |

The pre-commit hook runs Prettier on staged files, then all three.

Dependency installs follow a supply-chain policy (`pnpm-workspace.yaml`): a 7-day release-age
cooldown, and install scripts only for the native packages named in `allowBuilds`.
