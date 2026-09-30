# Personal Expenses Bot

A Telegram bot for recording and summarising personal and family expenses. You send a line like
`450 кофе` and it's recorded in your active ledger, in the ledger's currency and on your local
date. `/today` shows today's totals. The bot speaks Russian.

It's built for one household spread across countries and currencies (RSD, EUR, RUB, KZT, …). So
money is exact integer minor units, every user has their own timezone, and nothing is guessed
when an amount could be read two ways.

> **Status:** early. The walking skeleton (Plan 0001) is implemented and runs locally. Deploy,
> categories, summaries and settings are planned. See [Roadmap](#roadmap).

## Using the bot

| You send                             | The bot does                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`                             | Creates your account and a personal ledger («Личные расходы»)                                                                                                                                                                                                          |
| `450 кофе`                           | Records 450.00 in the ledger's default currency, in a category picked from how this ledger filed `кофе` before, else by keyword, else «Другое». Replies `Записано в «Личные расходы»: 450.00 RSD — кофе · Кафе и рестораны` with [Категория], [Изменить] and [Удалить] |
| `450 такси вчера`, `450 такси 25.09` | Records the expense on a past date. Only the last word is read as a date: `вчера`, `позавчера`, `dd.mm` (the most recent such date, today included) or `dd.mm.yyyy`. A future `dd.mm.yyyy` records nothing. The confirmation names the date when it isn't today        |
| [Категория]                          | Opens a paged list of the ledger's categories in the same message. A tap moves the expense there, and the next expense with the same description follows it                                                                                                            |
| [Изменить]                           | Offers [Сумма], [Описание] and [Дата] in the same message. The card then asks for the new value as your next message (the date prompt also has [Сегодня] [Вчера] [Позавчера]). [Отмена] puts the card back unchanged                                                   |
| `12,50 EUR такси`                    | Records 12.50 EUR. A currency code after the amount overrides the default (case-insensitive)                                                                                                                                                                           |
| `1 200 обед`                         | Records 1 200.00. Group thousands with a space                                                                                                                                                                                                                         |
| `1.200 обед`                         | Records **nothing** and replies to your message with one button per reading ([1 200.00 RSD] [1.20 RSD]). A tap records that reading. A second tap records nothing more                                                                                                 |
| `/today`                             | `Сегодня, 30 сентября — «Личные расходы»`, then one total per currency                                                                                                                                                                                                 |
| `/week`, `/month`                    | This week (Monday to Sunday) or calendar month: per currency a total, then its categories by amount. [◀ Август] [Октябрь ▶] page to the neighbouring period in the same message                                                                                        |
| [Удалить]                            | Soft-deletes that expense and turns the confirmation into a deleted card with [Вернуть]. A second tap says it's already deleted                                                                                                                                        |
| [Вернуть]                            | Restores the expense, and `/today` counts it again                                                                                                                                                                                                                     |
| `/categories`                        | Lists the ledger's categories, with [Добавить], [Переименовать] and [Скрыть]. Adding and renaming ask for the name as your next message. Adding a hidden category's name brings it back                                                                                |
| `/settings`                          | Shows your timezone and the ledger's default currency, with [Часовой пояс], [Валюта] and [Категории]. The timezone comes from a list of cities or, via [Другой…], any IANA name you type (`Europe/Istanbul`). Past expenses keep their date                            |
| `/cancel`                            | Drops a pending question (like the new category's name) and puts the list or the expense card back                                                                                                                                                                     |
| `/help`                              | How to record an expense, and what the menu buttons do                                                                                                                                                                                                                 |
| `/changelog`                         | What's new: one entry per version, newest first                                                                                                                                                                                                                        |

`/start` and `/help` show a persistent menu bar under the input field: [📊 Сегодня] answers like
`/today`, [📅 Неделя] like `/week`, [🗓 Месяц] like `/month`, [⚙️ Настройки] like `/settings`, and [❓ Помощь] like `/help`. Only the exact label is a menu tap. A menu tap or any
command also drops a pending question, which otherwise expires after 10 minutes. Unknown commands,
photos, stickers and voice messages get the help reply. Editing a sent expense doesn't change
the record, and the bot says so.

Only Telegram accounts listed in `ALLOWED_TELEGRAM_IDS` get any reply. Everyone else is
ignored. The first id listed is the admin: on a boot with a new version, the bot sends them a
short «🆕 Версия X.Y.Z» note (ADR-0013).

### Amount rules

One rule for everyone, regardless of locale ([ADR-0004](docs/adrs/0004-amount-parsing-rule.md)):

- `.` or `,` followed by 1–2 digits is a decimal separator: `12,5`, `12.50`.
- A space groups thousands in groups of three: `1 200`, `12 345 678`.
- A single `.` or `,` followed by exactly three digits (`1.200`, `1,200`) is ambiguous. The bot
  asks and never guesses, because a thousand-fold misread is the worst bug this product can
  have.
- Two separators (`1.200,50`), too many decimals for the currency, zero and negative amounts are
  rejected with a hint.

Supported currencies and their minor units are listed in
[`src/domain/currencies.ts`](src/domain/currencies.ts).

### Concepts

- **Ledger.** Every expense belongs to a ledger, never directly to a person. Each user starts
  with a personal ledger, and shared family or trip ledgers are planned. Every confirmation names
  the ledger it wrote to ([ADR-0002](docs/adrs/0002-ledgers-and-identity.md)).
- **Local date.** An expense is filed under the date in _your_ timezone when you sent it, so an
  expense sent at 00:30 counts for the new day.
- **Original currency.** Amounts are stored as sent. Converting to one home currency is planned
  for report time, never at record time
  ([ADR-0003](docs/adrs/0003-currency-conversion-at-report-time.md)).
- **Idempotent.** A message Telegram redelivers is never recorded twice.

## Running locally

Requirements: Node 24 (`.nvmrc`), and pnpm at the version pinned in `package.json`
`packageManager` (via Corepack or mise).

1. Create a bot with [@BotFather](https://t.me/BotFather). Use a **separate bot for
   development**, because two processes polling one token conflict.
2. Install and configure:

   ```sh
   pnpm install            # also installs the husky pre-commit hook
   cp .env.example .env    # fill in BOT_TOKEN and ALLOWED_TELEGRAM_IDS (your Telegram user id)
   pnpm dev                # long polling, restarts on change
   ```

3. Send `/start` to your bot.

Configuration is environment-only and validated at boot. Every variable is documented in
[.env.example](.env.example): token, allowlist, the timezone and currency new users get, the
SQLite path and the log level. Runtime data lives in `./data/` (gitignored).

## Running in Docker

Production runs compiled JavaScript from `dist/` in a multi-stage image
([ADR-0006](docs/adrs/0006-production-runs-compiled-js.md)). The same Compose file runs locally
and on the VPS:

```sh
cp .env.example .env         # a bot token that nothing else is polling
docker compose up -d --build --wait
docker compose logs -f bot
docker compose stop          # SIGTERM: heartbeat, polling, then the DB close cleanly
```

- The database lives on the named volume `bot-data` at `/app/data/bot.sqlite`. Compose sets
  `DATABASE_PATH` itself, so the value in `.env` is ignored in the container.
- Health is a heartbeat file next to the database, rewritten every 30 s once polling starts.
  `docker compose ps` shows the bot `unhealthy` when it is older than 120 s or missing.
- The container runs as uid 1000 (`node`). Backups go to the host directory `HOST_BACKUP_DIR`
  (default `/var/backups/personal-expenses-bot`), which must be owned by uid 1000.

Backup settings (the full list is in [.env.example](.env.example)):

| Variable          | Default                              | Meaning                                                                             |
| ----------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `BACKUP_DIR`      | unset (no backups)                   | Where the bot writes `expenses-YYYY-MM-DD.sqlite` (UTC date) at boot and every 24 h |
| `BACKUP_KEEP`     | `14`                                 | How many dated backup files to keep. Older ones are deleted                         |
| `HOST_BACKUP_DIR` | `/var/backups/personal-expenses-bot` | Compose only: the host directory bind-mounted as the container's `BACKUP_DIR`       |

Compose sets `BACKUP_DIR` itself. A same-day backup replaces that day's file, and a failed
backup is logged as an `error` without stopping the bot.

## Deploy

`.github/workflows/deploy.yml` runs `check` (install, typecheck, lint, build, test, and the deploy
script's own test) on every pull request and push to `main`. A push to `main` that passes `check`
connects over SSH with a key that can run only one thing: the deploy script
[scripts/deploy-vps.sh](scripts/deploy-vps.sh). It runs `git pull --ff-only`, then
`docker compose up -d --build --wait`, so a container that never turns healthy fails the run, and
then prunes dangling images and build cache older than a week. Deploys queue, never overlap.

Repository secrets:

| Secret     | Value                                   |
| ---------- | --------------------------------------- |
| `SSH_HOST` | VPS hostname or IP                      |
| `SSH_USER` | the deploy user (`botuser`)             |
| `SSH_KEY`  | the dedicated deploy key's private half |

VPS layout (the deploy user is uid 1000, in the `docker` group, with no sudo):

```text
~/bots/personal-expenses-bot/           # this repo, cloned over HTTPS (public repo, no deploy key)
~/bots/personal-expenses-bot/.env       # production token and ids, mode 0600, not in git
~/backups/personal-expenses-bot/        # expenses-YYYY-MM-DD.sqlite, mode 0700
~/bin/deploy-personal-expenses-bot      # installed copy of scripts/deploy-vps.sh
```

Production uses its **own** BotFather bot. Two processes polling one token get 409 Conflict.

One-time setup on the VPS, as the deploy user:

```sh
git clone https://github.com/IgorKonovalov/personal_expenses_bot.git ~/bots/personal-expenses-bot
install -d -m 700 ~/backups/personal-expenses-bot
mkdir -p ~/bin
install -m 755 ~/bots/personal-expenses-bot/scripts/deploy-vps.sh ~/bin/deploy-personal-expenses-bot
```

The VPS `.env` sets `HOST_BACKUP_DIR=/home/botuser/backups/personal-expenses-bot`, next to the
sibling bots' backups.

The deploy key belongs to this repo alone. Generate it on a laptop with
`ssh-keygen -t ed25519 -N '' -C gha-deploy-personal-expenses-bot -f ./deploy-key`, put
`deploy-key` into the `SSH_KEY` secret, and append the public half to the VPS
`~/.ssh/authorized_keys` as one line:

```text
restrict,command="/home/botuser/bin/deploy-personal-expenses-bot" ssh-ed25519 AAAA... gha-deploy-personal-expenses-bot
```

Then delete both local copies. The deploy user's `docker` group makes any shell on it
root-equivalent, which is why this key gets no shell: sshd runs the forced command whatever the
client asks for. The installed script is a copy. **After changing `scripts/deploy-vps.sh`, rerun
the `install -m 755` line above**, or the VPS keeps running the old one.

Manual redeploy, on the VPS: `~/bin/deploy-personal-expenses-bot`.

If `git pull --ff-only` fails, someone edited the checkout on the VPS. Reset it to `origin/main`
rather than forcing a merge.

### Restoring a backup

1. Stop the bot: `docker compose stop bot`.
2. Copy the backup into the volume, replacing the live file and dropping its WAL:

   ```sh
   docker compose run --rm --no-deps --entrypoint sh bot -c \
     'rm -f /app/data/bot.sqlite-wal /app/data/bot.sqlite-shm &&
      cp /var/backups/personal-expenses-bot/expenses-YYYY-MM-DD.sqlite /app/data/bot.sqlite'
   ```

3. Start it: `docker compose up -d --wait`. Boot applies any newer migrations to the restored
   file.

To inspect a backup without restoring it, copy the file off the VPS and open it read-only with
any SQLite client.

## Development

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Runs the bot with `tsx watch`, loading `.env` if present |
| `pnpm build`     | Compiles `src/` to `dist/` and copies the SQL migrations |
| `pnpm start`     | Runs the compiled bot, `node dist/index.js`              |
| `pnpm typecheck` | `tsc --noEmit`, strict                                   |
| `pnpm lint`      | ESLint (type-aware), including the layer-boundary rules  |
| `pnpm test`      | Vitest, against real in-memory SQLite (no DB mocks)      |
| `pnpm format`    | Prettier                                                 |

The pre-commit hook runs Prettier on staged files, then typecheck, lint and tests.

### Architecture

```
src/
├── domain/     pure: money, expense text, time windows, aggregation. No I/O, no framework
├── db/         SQLite connection, forward-only migrations, repositories. The only place with SQL
├── services/   use-cases orchestrating domain + db
├── bot/        the Telegram adapter (grammY): handlers, middleware, the Russian messages module
├── config.ts   env -> typed config, validated at boot
├── version.ts  the running version, read from package.json at boot
└── index.ts    boot
```

Lint rules enforce the boundaries: grammY only under `src/bot/`, and no I/O or wall-clock
reads in `src/domain/`. Stack and rationale:
[ADR-0001](docs/adrs/0001-tech-stack.md) (Node 24, strict TypeScript, grammY long polling,
better-sqlite3, pnpm, Vitest).

Non-negotiables, in short:

- Money is an integer in minor units plus an ISO-4217 code. Floats are forbidden everywhere.
- Instants are stored in UTC, and "today" is computed in the user's timezone.
- Amounts and descriptions never appear in logs above `debug`.
- All user-facing text lives in [`src/bot/messages.ts`](src/bot/messages.ts).

Dependencies follow a supply-chain policy (`pnpm-workspace.yaml`): exact pins, a 7-day
release-age cooldown, and install scripts only for the native packages named in `allowBuilds`.

### How work is organised

Features are designed before they're built. The [plans index](docs/plans/README.md) holds
phased implementation plans, and the [ADR index](docs/adrs/README.md) holds decisions and their
rejected alternatives. [CLAUDE.md](CLAUDE.md) is the orientation map. It also describes the
agent skills in `.claude/` that write plans (`architect`) and implement them (`dev`), and the
git hooks that guard commits.

## Roadmap

The approved and in-progress plans are listed in [docs/plans/README.md](docs/plans/README.md).
Next come deploy to a VPS with daily backups, categories with learned suggestions, past dates,
editing, weekly and monthly summaries, and per-user settings. Further out: shared ledgers,
currency conversion, fiscal QR receipts, bank SMS parsing, CSV/XLSX export and optional
encryption of personal ledgers.

## License

[MIT](LICENSE)
