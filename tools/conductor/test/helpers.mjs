// Shared scaffolding for the conductor tests: temp directories, plan documents in the shape
// the architect's template produces, and the path to the fake CLI.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = resolve(TEST_DIR, "..");
export const REPO = resolve(TOOL_DIR, "..", "..");
export const FAKE_CLAUDE = join(TEST_DIR, "fake-claude.mjs");
export const FAKE = [process.execPath, FAKE_CLAUDE];

// Every temp directory a test makes lives under TMP_ROOT/<pid>, one root per test process
// (`node --test` runs each file in its own), and that root is removed when the process exits.
// A run that is killed never reaches the exit hook, so the next process to load this module
// sweeps every root whose PID is gone. Nothing may call mkdtempSync(tmpdir()) directly, or a
// killed run leaks a fixture repo per test. CONDUCTOR_KEEP_TMP=1 keeps the directories for
// debugging a failure.
export const TMP_ROOT = join(tmpdir(), "peb-conductor-test");
const OWN_ROOT = join(TMP_ROOT, String(process.pid));
const KEEP = process.env.CONDUCTOR_KEEP_TMP === "1";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function remove(dir) {
  // maxRetries: a just-exited child (git, the fake CLI) can still be writing into the directory.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

/** Removes every per-process root under `root` whose PID is no longer running. */
export function sweepDeadRoots(root = TMP_ROOT) {
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) remove(join(root, name));
  }
}

if (!KEEP) {
  sweepDeadRoots();
  process.on("exit", () => remove(OWN_ROOT));
}

export function tmp(prefix = "peb-conductor-test-") {
  mkdirSync(OWN_ROOT, { recursive: true });
  return mkdtempSync(join(OWN_ROOT, prefix));
}

/**
 * spec: { number, title?, status?, phases: [{ id, owner, title?, stop?, files?, blocksMerge? }],
 *         rows?: { [id]: { state, commit? } }, closeReview?: string, lane? }
 */
export function planText(spec) {
  const title = spec.title ?? `Plan ${spec.number} fixture`;
  const lines = [
    `# ${spec.number}: ${title}`,
    "",
    `> **Status:** ${spec.status ?? "approved (2026-09-14)"}`,
    "> **Created:** 2026-09-14",
    "> **Related ADRs:** none",
    "",
    "## TL;DR",
    "",
    "A fixture.",
    "",
    "## Implementation phases",
    "",
  ];
  for (const p of spec.phases) {
    lines.push(`### Phase ${p.id}: ${p.title ?? `Step ${p.id}`}`);
    lines.push(`- **Owner skill:** ${p.owner}`);
    lines.push(`- **What:** phase ${p.id}.`);
    lines.push(`- **Files touched:** \`phase-${p.id}.txt\`${p.files ? `, ${p.files}` : ""}`);
    lines.push(`- **Done when:** the file exists.`);
    if (p.stop) lines.push(`- **Stop condition:** ${p.stop}`);
    if (p.blocksMerge) lines.push(`- **Blocks merge:** ${p.blocksMerge}`);
    lines.push("");
  }
  lines.push("## Implementation log", "", `**Lane:** ${spec.lane ?? "_(unset)_"}`, "");
  lines.push("| phase | owner | state | commit |", "|---|---|---|---|");
  for (const p of spec.phases) {
    const row = spec.rows?.[p.id] ?? { state: "not started" };
    lines.push(`| ${p.id}: ${p.title ?? `Step ${p.id}`} | ${p.owner} | ${row.state} | ${row.commit ? `\`${row.commit}\`` : ""} |`);
  }
  lines.push("", "### Notes", "", "### Close triggers", "");
  if (spec.closeReview) lines.push("## Close review", "", spec.closeReview, "");
  lines.push("## Followups", "");
  return lines.join("\n");
}

export function slugFor(spec) {
  return `${spec.number}-fixture`;
}

export function writePlan(repo, spec, { done = false } = {}) {
  const dir = done ? join(repo, "docs", "plans", "done") : join(repo, "docs", "plans");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slugFor(spec)}.md`);
  writeFileSync(path, planText(spec));
  return path;
}

/**
 * A red Vitest run, recorded with NO_COLOR=1 on vitest 5.0.1: a scratch file with two tests made to
 * fail and one skipped. Each failure is printed under `Failed Tests` as a ` FAIL  <file> > <suite> >
 * <name>` line, and the `Tests` summary line closes the run. Re-record it rather than edit it when
 * Vitest's shape moves.
 */
export const RED_VITEST_OUTPUT = [
  " RUN  v5.0.1 /tmp/red",
  "",
  " ❯ src/red.test.ts (5 tests | 2 failed | 1 skipped) 11ms",
  "   ❯ totals (2)",
  "     × sums to 1250 minor units 7ms",
  "   ❯ parser (3)",
  "     × reads the currency 2ms",
  "",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  src/red.test.ts > totals > sums to 1250 minor units",
  "AssertionError: expected 1200 to be 1250 // Object.is equality",
  "",
  "- Expected",
  "+ Received",
  "",
  "- 1250",
  "+ 1200",
  "",
  " ❯ src/red.test.ts:3:55",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯",
  "",
  " FAIL  src/red.test.ts > parser > reads the currency",
  "AssertionError: expected 'USD' to be 'EUR' // Object.is equality",
  "",
  'Expected: "EUR"',
  'Received: "USD"',
  "",
  " ❯ src/red.test.ts:8:50",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯",
  "",
  "",
  " Test Files  1 failed (1)",
  "      Tests  2 failed | 2 passed | 1 skipped (5)",
  "   Start at  11:20:30",
  "   Duration  161ms (transform 40%, tests 25%, import 25%, worker 9%)",
  "",
].join("\n");

export function outcomeBlock(obj) {
  return "Done.\n\n```conductor-outcome\n" + JSON.stringify(obj) + "\n```\n";
}
