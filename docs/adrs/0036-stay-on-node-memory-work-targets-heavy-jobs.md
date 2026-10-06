# ADR-0036: Stay on Node; memory work targets the heavy jobs, not the runtime

> **Status:** proposed
> **Date:** 2026-10-06
> **Related plan(s):** none yet. A heavy-job isolation plan follows only if the triggers below fire.

## Context

The bot runs on a shared DigitalOcean droplet with 1 vCPU, 961 MiB of RAM and 2 GiB of swap.
Four bots share it, each capped at 256 MiB, so the caps already add up to more than the RAM. The
target is 1k to 5k users. We asked whether a full rewrite to Rust is needed to fit that load.

Measurements on 2026-10-06 (production image locally, and the VPS read-only, running v0.12.0):

- **The idle bot is about 97 MiB RSS** with every dependency, the database and the bot modules
  loaded. Bare Node 24 accounts for 46 MiB of that. On the VPS the container held 36 MiB of anon
  memory plus 50 MiB in swap, and its cgroup `memory.peak` was 131 MiB over 3 days, with no OOM
  kills.
- **The heavy job sets the cap.** A receipt-photo QR decode with the ADR-0034 retry passes reaches
  about 225 to 317 MiB RSS, and Node keeps that RSS after the decode. The 384 MiB `mem_limit` in
  v0.13.0 exists only for that job (`docker-compose.yml`, `src/fiscal/qrPixels.ts`). v0.13.0 is
  not deployed yet.
- **Memory barely depends on the number of users.** Expenses, flow sessions (ADR-0009) and rates
  live in SQLite on disk, and the database is 2 MB. The only per-user state in memory is the
  unlocked ledger keys, and they expire when idle. `bot.start` handles one update at a time, so
  two heavy jobs never overlap.
- **The scaling limits are CPU and latency, not memory.** On 1 vCPU, a QR decode or an Argon2id
  unlock (64 MiB) makes every other user wait behind it. Telegram's send limit of about 30
  messages a second limits pushes. A runtime change fixes neither.

## Decision

We stay on Node 24 + TypeScript as ADR-0001 records. Memory work targets the heavy jobs (the
receipt QR decode, and the PDF statement parse when plan 0027 lands), never the runtime. The first
step is measurement: after v0.13.0 deploys, we read the container's cgroup `memory.peak`,
`memory.events` `oom_kill`, idle anon RSS, and the host's swap and `/proc/pressure/memory` for at
least a week of real traffic. This ADR is accepted when that data confirms the numbers above.

Two triggers reopen the question, and each has a set first response:

- **The heavy job is the problem.** This trigger fires on any `oom_kill`, on a `memory.peak`
  within 10% of the cap, or on host memory pressure that stays elevated (PSI `some avg60` above
  10). The response is a plan that runs the heavy jobs in a short-lived child process, one at a
  time and under its own memory cap. The bot's cap then drops back near its idle size. Resizing
  the droplet is the human-owned alternative to that plan.
- **The runtime is the problem.** This trigger fires when idle anon RSS, measured with no heavy
  job running, goes above 150 MiB, or when it grows with the user count at 1k or more users. Only
  this trigger reopens a runtime change, and it does so with a new ADR that supersedes this one.

## Consequences

### Positive
- The approved plans, the tests, the ADRs and the dev/conductor tooling stay valid. None of them
  wait on a rewrite.
- The memory work goes to the one job that drives the peak. That also helps the CPU and latency
  limits, which a rewrite would not touch.
- The decision rests on measured production data, with triggers we can check, not on a forecast.

### Negative
- Node's floor stays at about 50 MiB, and the bot idles near 100 MiB. A Rust binary would
  probably idle at 15 to 25 MiB (unmeasured). On a 1 GB droplet shared by four bots, that
  difference is real.
- Until the heavy jobs are isolated, a decode keeps its peak RSS after it finishes. The
  measurement week accepts that risk on a box that is already overcommitted.
- The jobs still block the event loop, so a decode delays other users' updates on 1 vCPU. This
  ADR records that limit, and it does not fix it.

## Alternatives considered

### Alternative A: Rewrite the whole bot in Rust

This would mean teloxide, rusqlite, chrono-tz or jiff, the argon2 crate, and rxing or native
zxing-cpp. It would save perhaps 60 to 80 MiB of idle memory and cut the QR peak to an estimated
50 to 80 MiB, all unmeasured. The cost is about 14k lines of production code and 15k lines of
tests, every ADR that names a TypeScript library, and the tooling, while the approved plans wait.
Extracting positioned text from PDFs (ADR-0033) is also clearly weaker in Rust. It lost because
memory does not grow with users. Isolating the heavy jobs gets most of the saving at a small
fraction of the cost, and a bigger droplet gets it for all four bots at once.

### Alternative B: A Rust sidecar for the QR decode only

This is the scoped version of Alternative A: a small binary that the bot runs for each receipt
photo. It lost for now because it adds a second toolchain, build stage and supply chain for one
job, before we know whether that job is a problem. If the heavy-job trigger fires and a Node child
process under its own cap is not enough, this is the next step. It reuses the same process
boundary.
