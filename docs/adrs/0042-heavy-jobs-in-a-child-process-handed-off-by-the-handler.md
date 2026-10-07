# ADR-0042: Receipt-photo and statement jobs run in a short-lived child process, handed off by the handler

> **Status:** accepted (2026-10-07), with an outcome
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0039](../plans/done/0039-scale-hardening.md)

## Context

The bot handles updates one at a time: `bot.start()` awaits each update's middleware before it
starts the next. Two handlers do heavy work inside that await:

- `registerReceiptMedia` downloads an image and runs `decodeQr`. That is a jpeg-js decode plus up
  to `QR_RETRY_BUDGET_MS` of retry passes, all synchronous, about 0.5 to 2.5 s per photo.
- `registerStatement` downloads a PDF and runs `readPdfLines` on pdfjs in the main thread.

While either runs, every other user's update waits. Ten photos arriving together queue for 10 to
25 s. The same jobs set the memory cap: a decode peaks at 225 to 317 MiB RSS against the 384 MiB
`mem_limit`, and Node keeps that RSS after the job (ADR-0036).

Moving the work off the main thread is not enough on its own. A handler that awaits a job in a
worker or a child still holds the update queue, because grammY waits for the handler.

ADR-0036 (proposed) already names the response for the memory side: run the heavy jobs in a
short-lived child process, one at a time.

## Decision

The photo and PDF handlers keep their cheap synchronous checks (mime type, size,
`getFile`). They then hand the job to an in-process queue and return, so the next update starts
at once. The queue runs **one job at a time in a freshly forked Node child**: `src/jobs/child.ts`
over IPC with `serialization: 'advanced'`. It kills the child at a time limit, and the child
exits after its one job, returning its memory.

The job's continuation runs in the bot process with the captured `ctx` and does what the handler
did after the decode: record, reply, delete the photo. An error in it goes through the same
logging and reply as the error boundary. The queue holds at most 8 waiting jobs. Past that, the
sender is told to retry later.

The update loop itself stays sequential. This is the first response ADR-0036 set, taken now for
latency rather than on its memory trigger.

## Consequences

### Positive
- No update waits behind a photo or a PDF. Only that user's own result is delayed.
- A decode's memory peak lives and dies in the child. A crash or an OOM kills the child, not the
  bot, and the user gets the "unreadable" reply.
- Everything else keeps the single-writer, one-update-at-a-time model. No handler has to be
  audited for interleaving.

### Negative
- Every job pays for a child process start: Node boot plus the zxing-wasm instantiate, an
  estimated 150 to 250 ms that Phase 5 of Plan 0039 measures. That runs off the main thread, so
  it delays only the sender.
- Within one chat, ordering is no longer strict. A message sent after a photo can be answered
  before the photo's receipt. The receipt card already arrives asynchronously when it is enriched
  (ADR-0018), so the chat tolerates this.
- A handler that used to call `next()` on an outcome found after the decode must now reproduce
  the fallthrough reply itself. That is the PDF statement path's "not this statement".
- The container cap must still fit the bot and one child at their peaks together. It can drop
  only after measurement (ADR-0036).
- Tests must wait for the queue to drain before they assert.

## Alternatives considered

### Alternative A: a long-lived worker thread
A warm `worker_threads` worker has no startup cost. But its WASM memory and RSS stay inside the
bot's process after the first photo, so the 384 MiB cap stays. An OOM still takes down the whole
bot, and the handler still awaits it unless it hands off the same way. It contradicts ADR-0036's
set response for no gain beyond about 200 ms per photo.

### Alternative B: concurrent updates (grammY runner with `sequentialize` per chat)
This gives the most throughput and keeps per-chat order. It lost because every handler, flow and
anchor would then interleave at its await points with other chats' handlers. Group and private
updates already share ledgers. That is a codebase-wide audit to fix two handlers. Revisit it when
the slow-update log (Plan 0039 Phase 1) shows stalls that are not heavy jobs.

### Alternative C: stay inline, add timeouts only
Cheapest, but each photo still blocks every user for up to 2.5 s. Timeouts alone don't fix that.

## Outcome (2026-10-07)

Plan 0039 Phase 5 measured the child's start, fork to `ready`, at 41 to 45 ms from `dist/` (102
to 106 ms from source under tsx), and about 148 ms per photo job end to end on the dev machine.
That is below the 150 to 250 ms estimated under Negative.
