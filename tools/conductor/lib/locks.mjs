// The machine-wide `close` lock the conductor takes, and the file lock under it.
//
// `close` is held from before a close session starts until `main` has fast-forwarded, and never over
// a review, so the version a close bumps lands on the main it was computed against.
//
// The lock is a file, <lock dir>/<name>.lock, created by hard-linking a fully written temp file onto
// the lock path: the link either fails with EEXIST or produces a complete file, so a reader never
// sees a half-written holder. The holder is the PID of the process that took it. A lock whose holder
// PID is no longer alive is taken over; the takeover itself runs under a short-lived
// `<name>.lock.takeover` guard, so two waiters that both see the same dead holder cannot each delete
// the lock the other has just taken. A guard older than GUARD_STALE_MS is abandoned.
//
// Every lane on the machine shares one lock directory, os.tmpdir()/peb-conductor-locks or
// CONDUCTOR_LOCK_DIR, which is what makes the lock machine-wide rather than per-worktree.
// Trap: a PID can be reused by an unrelated process after the holder dies; the lock then waits on a
// stranger until that process exits. The holder file records `what` so a person can tell.

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLOSE = "close";

const GUARD_STALE_MS = 10_000;

export function lockDir(env = process.env) {
  return env.CONDUCTOR_LOCK_DIR || join(tmpdir(), "peb-conductor-locks");
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function lockPath(name, dir) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid lock name: ${name}`);
  return join(dir, `${name}.lock`);
}

/** The current holder of `name`, or null when the lock is free or its file is unreadable. */
export function holder(name, dir = lockDir()) {
  try {
    return JSON.parse(readFileSync(lockPath(name, dir), "utf8"));
  } catch {
    return null;
  }
}

function tryCreate(path, record) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function takeOverIfDead(path, seen) {
  const guard = `${path}.takeover`;
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) unlinkSync(guard);
    } catch {}
    return;
  }
  try {
    let current = null;
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    if (current && current.token === seen.token && !pidAlive(current.pid)) unlinkSync(path);
  } finally {
    try {
      unlinkSync(guard);
    } catch {}
  }
}

/**
 * Waits for and takes the lock. Resolves to a handle whose `release()` frees it (only if this
 * process still holds it) and whose `waitedMs` is how long the wait took.
 */
export async function acquire(name, opts = {}) {
  const dir = opts.dir ?? lockDir();
  const pollMs = opts.pollMs ?? 500;
  mkdirSync(dir, { recursive: true });
  const path = lockPath(name, dir);
  const record = {
    name,
    pid: opts.pid ?? process.pid,
    token: randomBytes(8).toString("hex"),
    started: new Date().toISOString(),
    what: opts.what ?? null,
  };
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    if (tryCreate(path, record)) break;
    const seen = holder(name, dir);
    if (seen && !pidAlive(seen.pid)) {
      takeOverIfDead(path, seen);
      continue;
    }
    if (!announced && opts.onWait) opts.onWait(seen);
    announced = true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const waitedMs = Date.now() - t0;
  return {
    name,
    token: record.token,
    waitedMs,
    acquiredAt: Date.now(),
    release() {
      const current = holder(name, dir);
      if (current && current.token === record.token) {
        try {
          unlinkSync(path);
        } catch {}
      }
    },
  };
}

/** Takes `name`, reporting the wait through `onWaited(ms)` once it is held. */
export async function take(name, { dir, pollMs, what, onWaiting, onWaited } = {}) {
  const lock = await acquire(name, { dir, pollMs, what, onWait: onWaiting });
  onWaited?.(lock.waitedMs);
  return lock;
}
