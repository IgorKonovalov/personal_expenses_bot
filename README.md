# Personal Expenses Bot

A Telegram bot for recording and summarising personal and family expenses. You send a line like
`450 кофе` and it's recorded in your active ledger, in the ledger's currency and on your local
date. `/today` shows today's totals. The bot speaks Russian.

**User guide (in Russian, with chats generated from the real bot):
<https://igorkonovalov.github.io/personal_expenses_bot/docs/>**

It's built for one household spread across countries and currencies (RSD, EUR, RUB, KZT, …). So
money is exact integer minor units, every user has their own timezone, and nothing is guessed
when an amount could be read two ways.

> **Status:** in daily use by one household, deployed on a VPS. The running version is in
> `package.json` and `/changelog` says what each one brought. See [Roadmap](#roadmap) for what's
> next.

## Using the bot

Users join by invitation and talk to the bot in a private chat, or add it to a group for shared
books. Every reply, button and flow is described, with pictures of the real chat, in the
[user guide](https://igorkonovalov.github.io/personal_expenses_bot/docs/), which `/help` links
too. In short, the bot:

- records `450 кофе`, with currency codes, signs and words, a `к` thousands suffix, amount-last
  text, past dates and tags, and asks instead of guessing an ambiguous amount;
- shows `/today`, `/week` and `/month` by category, with charts in a Mini App, and sends a
  monthly (optionally weekly) summary;
- keeps a budget with payday periods and category caps, recurring expenses, debts and split
  bills, and tags for trips and projects;
- reads Serbian and Montenegrin fiscal receipts (QR photo, link or live scan) with their items
  and product prices, Serbian bank SMS, and Raiffeisen banka Srbija PDF statements;
- converts reports between currencies at the NBS middle rate of the expense's day;
- keeps a group's shared ledger with totals per member and an equal-split settle-up;
- can seal a personal ledger with a passphrase, and exports everything as CSV or Excel.

The site's architecture section («Как это устроено») explains the design for a technical
reader; the decisions themselves are in [docs/adrs/](docs/adrs/README.md).

## Running locally

Requirements: Node 24 (`.nvmrc`), and pnpm at the version pinned in `package.json`
`packageManager` (via Corepack or mise).

1. Create a bot with [@BotFather](https://t.me/BotFather). Use a **separate bot for
   development**, because two processes polling one token conflict.
2. Install and configure:

   ```sh
   pnpm install            # also installs the husky pre-commit hook
   cp .env.example .env    # fill in BOT_TOKEN and ADMIN_TELEGRAM_ID (your Telegram user id)
   pnpm dev                # long polling, restarts on change
   ```

3. Send `/start` to your bot.

Configuration is environment-only and validated at boot. Every variable is documented in
[.env.example](.env.example): token, the admin id and the ids admitted at boot, the timezone and
currency new users get, the SQLite path and the log level. Runtime data lives in `./data/`
(gitignored).

`ADMIN_TELEGRAM_ID` and `ADMIT_TELEGRAM_IDS` replace `ALLOWED_TELEGRAM_IDS`. A boot with the old
variable still set fails with a message naming the new ones: set `ADMIN_TELEGRAM_ID` to the old
first id and `ADMIT_TELEGRAM_IDS` to the rest, then remove `ALLOWED_TELEGRAM_IDS`.

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

| Variable             | Default                              | Meaning                                                                                                     |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `BACKUP_DIR`         | unset (no backups)                   | Where the bot writes `expenses-YYYY-MM-DD.sqlite.gz` (UTC date, gzip) at boot and every 24 h                |
| `BACKUP_KEEP`        | `7`                                  | How many daily backup files to keep                                                                         |
| `BACKUP_KEEP_WEEKLY` | `4`                                  | How many Sunday (UTC date) backup files to keep besides the dailies. A Sunday among the dailies counts once |
| `HOST_BACKUP_DIR`    | `/var/backups/personal-expenses-bot` | Compose only: the host directory bind-mounted as the container's `BACKUP_DIR`                               |

Compose sets `BACKUP_DIR` itself. Each backup is an online copy, gzip-compressed, then the
uncompressed copy is removed, so a backup briefly needs one uncompressed copy's worth of free
disk. Files older than both windows are deleted; an uncompressed `expenses-YYYY-MM-DD.sqlite`
from before compression counts as a daily by its date. A boot on a UTC day that already has a
backup writes none, and a failed backup is logged as an `error` without stopping the bot.
Deleted data can survive in a backup for `max(BACKUP_KEEP, 7 × BACKUP_KEEP_WEEKLY)` days (28 with
the defaults), which is what `/delete_account` says. A ledger sealed with a passphrase
([ADR-0020](docs/adrs/0020-sealed-ledgers-write-open-read-locked.md)) is plaintext in backups
taken before the switch until rotation (`BACKUP_KEEP`, `BACKUP_KEEP_WEEKLY`) drops them.

### Admission and the admin

The bot works by invitation
([ADR-0024](docs/adrs/0024-admission-lives-in-the-database-via-invite-codes.md)). The admin
(`ADMIN_TELEGRAM_ID`) sends `/invite` and gets a link `https://t.me/<bot>?start=<code>` that
admits up to 10 people within 14 days; `/invite 30 7` makes one for 30 people and 7 days (each
number from 1 to 1000). Opening the link starts the bot as a normal `/start`. A link that is used
up, expired or switched off answers «Ссылка недействительна или истекла». Anyone else gets one
«Бот работает по приглашениям» reply and then silence. `ADMIT_TELEGRAM_IDS` admits the listed ids
at boot, without a link.

Admin-only commands (anyone else gets the `/help` answer; the admin's [☰ Ещё] has a button for
each):

| Admin sends            | The bot does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `/invite [uses days]`  | Makes an invite link                                                                               |
| `/invites`             | Lists the live links with `used/max` and the expiry date, each with [Отключить] to switch it off   |
| `/block <telegram id>` | Drops every update from that account, in private and in groups; `/unblock <telegram id>` undoes it |
| `/stats`               | Admitted users, users and expenses of the last 7 days, live links. Counts only, no amounts         |
| `/refund <charge id>`  | Returns a donation's Stars through Telegram and marks it refunded; a second call doesn't call Telegram |

Limits for everyone but the admin: at most 30 updates per minute (the rest are dropped silently),
and 20 receipts per local day («Лимит чеков на сегодня исчерпан, попробуйте завтра»). On a boot
with a new version, the bot sends the admin a short «🆕 Версия X.Y.Z» note (ADR-0013).

### Groups

For a group's shared ledger ([ADR-0014](docs/adrs/0014-group-chats-bind-to-shared-ledgers.md)),
in [@BotFather](https://t.me/BotFather) set `/setjoingroups` to Enabled and `/setprivacy` to
Disabled, so the bot reads ordinary group messages. A privacy change applies only to groups the
bot joins afterwards, so remove the bot from a group and add it again after changing it. Only an
admitted user can add the bot; added by anyone else, it leaves.

### Donations

The bot is free for everyone, with no paid tier
([ADR-0027](docs/adrs/0027-donations-only-funding.md)). At boot it creates one Telegram Stars
invoice link per preset amount; a preset whose link can't be created is left out. `DONATE_URL`
adds an external «Ko-fi» button to `/donate`. With no link and no `DONATE_URL`, `/donate` says
donations are unavailable. A payment is checked before Telegram takes it (the currency must be
Stars and the amount a preset) and stored once per Telegram charge id. The admin gets one notice
per donation with the amount, the internal user id and the charge id, never a name.
`/paysupport <текст>` relays a user's refund request to the admin.

### Receipts

A receipt is recorded offline from its QR code, then its shop and items are fetched from the tax
authority's site ([ADR-0018](docs/adrs/0018-receipts-record-offline-enrich-async.md)). Besides
Telegram and the NBS below, these are the only hosts the bot connects to, and only for that:

- `suf.purs.gov.rs` (Serbia): the verify URL as JSON and as HTML, and `POST /specifications`
- `mapr.tax.gov.me` (Montenegro): `POST /ic/api/verifyInvoice`

### Currency conversion

Reports convert at the NBS middle rate
([ADR-0022](docs/adrs/0022-fx-nbs-middle-rate-ledger-currency.md)). A worker fetches the rate
lists at boot and then hourly, so the bot needs outbound HTTPS to `webappcenter.nbs.rs`. If NBS
can't be reached, reports fall back to per-currency blocks.

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
~/backups/personal-expenses-bot/        # expenses-YYYY-MM-DD.sqlite.gz, mode 0700
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

### GitHub Pages: the Mini App and the docs site

One Pages artifact holds the Mini App
([ADR-0025](docs/adrs/0025-static-mini-app-fragment-in-senddata-out.md)) at the root and the
docs site ([ADR-0048](docs/adrs/0048-a-russian-docs-site-beside-the-mini-app-with-chats-generated-from-the-real-bot.md))
under `docs/`. `.github/workflows/pages.yml` builds both on every push and pull request and
deploys only a push to `main`, so a broken docs build also holds back a Mini App change.

- The Mini App lives in `webapp/`: `index.html` plus TypeScript built by `pnpm build:webapp`
  (plain `tsc`, no bundler, no runtime dependencies) into `webapp/dist/`. It makes no network
  request: its CSP allows scripts from `telegram.org` and itself only. A visit whose fragment
  carries no payload is sent on to `./docs/`.
- The docs site lives in `site/`, a standalone Starlight project with its own lockfile under the
  same release-age cooldown. `pnpm docs:chats` runs the scenarios in `scripts/docs-chats/`
  through the bot in memory and writes the chat transcripts the pages draw; `pnpm docs:check`
  fails when a menu command is on no guide page or an architecture page links a missing ADR.
  `pnpm docs:build` does the whole build into `.pages/`, and `pnpm docs:dev` serves the site
  locally.
- Enable Pages with the source "GitHub Actions", then set `WEBAPP_URL` to the published root URL
  (`https://igorkonovalov.github.io/personal_expenses_bot/`), without a `#fragment`. With
  `WEBAPP_URL` set, the private menu gains «📷 Скан» and reports gain «📈 Диаграмма». Telegram
  keeps showing an old menu until the next `/start` or `/help` reply.
- Deploy the page before the bot when a change touches the chart payload: until the Pages run
  has finished, the old page answers a new `#z=` button with its open-from-bot line.
- The chart payload is capped at 2048 characters. To measure what your clients really open, run
  `pnpm probe:webapp` with `BOT_TOKEN`, `ADMIN_TELEGRAM_ID` and `WEBAPP_URL` set (in the
  environment or `.env`), after the page is published. It sends the admin one message with a
  «Проба N» button per length, 2048 to 32768 characters. A button that opens showing its own
  «Проба N» title arrived whole. A length the Bot API refuses is printed with its error; the
  script prints only sizes and errors, never the token or a URL.

### Restoring a backup

1. Stop the bot: `docker compose stop bot`.
2. Unpack the backup into the volume, replacing the live file and dropping its WAL:

   ```sh
   docker compose run --rm --no-deps --entrypoint sh bot -c \
     'rm -f /app/data/bot.sqlite-wal /app/data/bot.sqlite-shm &&
      gunzip -c /var/backups/personal-expenses-bot/expenses-YYYY-MM-DD.sqlite.gz > /app/data/bot.sqlite'
   ```

   An uncompressed `expenses-YYYY-MM-DD.sqlite` from before compression is copied with `cp`
   instead of `gunzip -c … >`.

3. Start it: `docker compose up -d --wait`. Boot applies any newer migrations to the restored
   file.

To inspect a backup without restoring it, copy the file off the VPS, `gunzip` it, and open it
read-only with any SQLite client.

## Development

| Command           | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `pnpm dev`        | Runs the bot with `tsx watch`, loading `.env` if present        |
| `pnpm build`      | Compiles `src/` to `dist/` and copies the SQL migrations        |
| `pnpm start`      | Runs the compiled bot, `node dist/index.js`                     |
| `pnpm typecheck`  | `tsc --noEmit`, strict                                          |
| `pnpm lint`       | ESLint (type-aware), including the layer-boundary rules         |
| `pnpm test`       | Vitest, against real in-memory SQLite (no DB mocks)             |
| `pnpm format`     | Prettier                                                        |
| `pnpm docs:build` | Builds the Mini App and the docs site into `.pages/`            |
| `pnpm docs:dev`   | Generates the chats and serves the docs site locally            |

The pre-commit hook runs Prettier on staged files, then typecheck, lint and tests.

### Architecture

```
src/
├── domain/      pure: money, expense text, time windows, aggregation, sealing. No I/O, no framework
├── db/          SQLite connection, forward-only migrations, repositories. The only place with SQL
├── services/    use-cases orchestrating domain + db
├── bot/         the Telegram adapter (grammY): handlers, middleware, the Russian messages module
├── fiscal/      the receipts adapter: QR decoding and the tax-site fetchers
├── statements/  the bank-statement adapter: PDF text as positioned lines (pdfjs-dist, lazy)
├── fx/          the rates adapter: the NBS middle-rate fetcher and its hourly worker
├── config.ts    env -> typed config, validated at boot
├── logger.ts    pino factory
├── heartbeat.ts liveness file + the Docker health-check entry
├── version.ts   the running version, read from package.json at boot
└── index.ts     boot
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
agent skills in `.claude/` that write plans (`architect`), implement them (`dev`) and review chat
UX (`ux-telegram`), and the git hooks that guard commits. Approved plans can also run unattended
through the [conductor](tools/conductor/README.md)
([ADR-0010](docs/adrs/0010-approved-plans-run-under-a-forked-conductor-on-trial.md)).

## Roadmap

Active and drafted plans are listed in [docs/plans/README.md](docs/plans/README.md): currently
tags for projects and trips, debts between people, and onboarding.
Further out: fiscal receipts from Russia and Kazakhstan, more bank SMS templates, and CSV/XLSX
export.

## License

[MIT](LICENSE)
