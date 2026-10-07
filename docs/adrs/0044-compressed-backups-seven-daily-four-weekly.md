# ADR-0044: Backups are gzip-compressed, with 7 daily and 4 weekly copies kept

> **Status:** proposed
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0039](../plans/0039-scale-hardening.md)

## Context

`startBackups` (`src/db/backup.ts`) takes an online SQLite copy at boot and every 24 h. It keeps
`BACKUP_KEEP` (default 14) uncompressed dated files on the VPS's own disk, so the copies take
about 14 to 15 times the database on disk. The 2026-10-07 sizing measured about 500 bytes per
expense and about 1.6 KB per receipt with 8 items, indexes included. At 10,000 users after two
years, that projects to a database of about 1.6 to 4 GB, so 25 to 60 GB of backups on a shared
droplet. Every deploy also rewrites that day's full copy.

`/delete_account` tells the user how long their data lingers in backups, derived from
`BACKUP_KEEP` (`messages.deleteAccountPrompt`).

## Decision

Each backup is the same online copy to a temp file, then gzip-streamed (`node:zlib`) to
`expenses-YYYY-MM-DD.sqlite.gz`. The temp file is removed after. Retention keeps:

- the newest `BACKUP_KEEP` daily files (default 7);
- the newest `BACKUP_KEEP_WEEKLY` Sunday files (UTC date, default 4).

A boot does not back up when today's file already exists. `PRAGMA optimize` runs after each
backup.

Deleted data can survive in a backup for `max(BACKUP_KEEP, 7 × BACKUP_KEEP_WEEKLY)` days, 28 with
the defaults. The weekly copy taken on the day of a deletion stays until four more Sundays pass.
`/delete_account` quotes that figure.

## Consequences

### Positive
- About 11 files at an estimated one third of the size each: roughly 3 to 4 times the database
  on disk instead of 15. The ratio is an estimate; Plan 0039 logs the real one.
- A month of restore points instead of two weeks.
- A deploy no longer rewrites a multi-GB copy.

### Negative
- A deleted user's data lingers up to 28 days instead of 14. The copy says so.
- A restore needs `gunzip` first.
- Each backup briefly needs one uncompressed copy's worth of free disk.
- Compressing on 1 vCPU takes time, though it runs in libuv's thread pool, not the event loop.
- The backups still sit on the same VPS. Losing the droplet loses them.

## Alternatives considered

### Alternative A: the same, plus an off-site copy
Pushing each daily to another host or an S3-compatible bucket protects against losing the VPS.
It lost for now: it adds a credential, a target to run and a dependency, and nothing at today's
size forces it. It is the next step when the data matters more than the setup cost.

### Alternative B: keep 14 uncompressed dailies
Fine at today's few MB, and it costs disk linearly. It lost on the projection above.

### Alternative C: zstd
`node:zlib`'s zstd compresses better and faster, but it is experimental in Node 24. gzip is
stable and good enough.
