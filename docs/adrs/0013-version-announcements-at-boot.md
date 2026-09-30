# ADR-0013: Announce each new version to the admin at boot, recorded in SQLite

> **Status:** proposed
> **Date:** 2026-09-30
> **Plan:** Plan 0008

## Decision

At boot, the bot compares `package.json`'s `version` with `app_state.last_announced_version` in
SQLite. If they differ, it sends the Russian announcement for the current version, taken from
`messages.versionAnnouncements`, to the admin, and records the version only after Telegram
accepts the message. The admin is the first id in `ALLOWED_TELEGRAM_IDS`. Every version bump
announces, minor and patch alike. A boot with an unchanged version sends nothing.

Delivery is at-least-once. A crash between the send and the write repeats the announcement on
the next boot. A failed send is logged at `warn`, left unrecorded, and retried on the next boot.

## Alternatives rejected

- **A marker file beside the database** (like the heartbeat). No migration, but the file sits
  outside the SQLite backups, so a restore from backup and the marker disagree.
- **A `sendMessage` step in `deploy.yml` after the SSH deploy.** No app state, but the bot token
  moves into GitHub secrets, the copy leaves the messages module, and a deploy that reports
  success before the container is healthy still pings.
- **Broadcast to every user, as the sibling does.** Deferred, not refused. It needs per-user
  state and inactive-marking for blocked chats. The `app_state` row and the announcement map
  carry over when a later plan broadcasts.
- **Minor-only announcements, as the sibling does.** The user asked for every bump for now.
  Silencing patches later is a one-line filter in the announcer, not a new decision.
- **A dedicated `ADMIN_TELEGRAM_ID` variable.** Explicit, but the user chose no new config. The
  cost: the order of `ALLOWED_TELEGRAM_IDS` now means something, and `.env.example` says so.

## Consequences

- Every version bump needs an entry in `messages.versionAnnouncements`. A test makes a bump
  without one fail the gate, so the close ceremony writes the copy together with the bump. That
  map is the one production file the architect edits, at a close only, and the conductor's close
  prompt says so too. We rejected having `dev` pre-write the next version's entry during a plan:
  the number is decided at close, and two plans closing out of order would claim the same one.
- `/changelog` renders the same map, so the push and the on-demand history never disagree.
