// The conductor's gate: what it runs by default, where it stops, and what a red leaves behind.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { defaultGate, gateForStage, runGate } from "../lib/gate.mjs";
import { project } from "../project.mjs";
import { RED_VITEST_OUTPUT, tmp } from "./helpers.mjs";

test("the default gate is project.mjs's gate, in order, each node --test naming its glob as one argument", () => {
  // Node 24 loads a directory argument to `node --test` as a module and runs no test; the glob is
  // expanded by node itself, so it travels as one literal argument with no shell.
  assert.deepEqual(
    defaultGate().map((c) => c.cmd),
    [
      ["pnpm", "typecheck"],
      ["pnpm", "lint"],
      ["pnpm", "test"],
      ["node", "scripts/check-doc-links.mjs"],
      ["node", "--test", ".claude/hooks/*.test.mjs"],
      ["node", "--test", "tools/conductor/test/*.test.mjs"],
    ],
  );
});

test("defaultGate hands out copies, so a caller's edit never reaches project.mjs", () => {
  const g = defaultGate();
  g[0].cmd.push("--changed");
  g[0].name = "edited";
  assert.deepEqual(project.gate[0], { name: "typecheck", cmd: ["pnpm", "typecheck"] });
});

test("an afterClose step runs only on a tree a close produced; every other step runs at every stage", () => {
  const commands = [
    { name: "always", cmd: ["x"] },
    { name: "probe", cmd: ["y"], afterClose: true },
  ];
  for (const stage of ["post-close", "remerge"]) assert.deepEqual(gateForStage(stage, commands).map((c) => c.name), ["always", "probe"]);
  for (const stage of ["pre-review", "fix-1", "fix-2"]) assert.deepEqual(gateForStage(stage, commands).map((c) => c.name), ["always"]);
  assert.deepEqual(gateForStage("pre-review").map((c) => c.name), defaultGate().map((c) => c.name), "this project's gate has no afterClose step");
});

test("a red step stops the gate, names its failing Vitest tests, and writes its log", async () => {
  const node = process.execPath;
  const dir = tmp();
  const script = join(dir, "vitest-stand-in.cjs");
  writeFileSync(
    script,
    "console.log(' FAIL  src/domain/money.test.ts > formatMoney > formats 1250 minor units');\n" +
      "console.log(' FAIL  src/domain/money.test.ts > formatMoney > formats 1250 minor units');\n" +
      "console.log(' FAIL  src/db/expenses.test.ts > insert > is idempotent');\n" +
      "console.log('      Tests  2 failed | 100 passed (102)');\nprocess.exit(1)\n",
  );
  const started = [];
  const g = await runGate({
    cwd: dir,
    logDir: join(dir, "gates"),
    label: "0099-pre-review",
    onCommandStart: (c) => started.push(c.name),
    commands: [
      { name: "typecheck", cmd: [node, "-e", "process.exit(0)"] },
      { name: "test", cmd: [node, script] },
      { name: "never", cmd: [node, "-e", "process.exit(0)"] },
    ],
  });
  assert.equal(g.ok, false);
  assert.deepEqual(g.ran, ["typecheck", "test"]);
  assert.deepEqual(started, ["typecheck", "test"], "the step after the red never starts");
  assert.equal(g.failed.name, "test");
  assert.equal(g.failed.code, 1);
  assert.deepEqual(g.failed.tests, ["src/domain/money.test.ts > formatMoney > formats 1250 minor units", "src/db/expenses.test.ts > insert > is idempotent"]);
  assert.match(readFileSync(g.failed.log, "utf8"), /2 failed \| 100 passed/);
  assert.equal(g.failed.log, join(dir, "gates", "0099-pre-review-01-test.log"));
});

test("a green gate runs every step and reports each one's exit code", async () => {
  const node = process.execPath;
  const g = await runGate({
    cwd: tmp(),
    logDir: tmp(),
    label: "green",
    commands: [
      { name: "a", cmd: [node, "-e", "process.exit(0)"] },
      { name: "b", cmd: [node, "-e", "process.exit(0)"] },
    ],
  });
  assert.equal(g.ok, true);
  assert.deepEqual(g.ran, ["a", "b"]);
  assert.deepEqual(g.commands.map((c) => [c.name, c.code]), [["a", 0], ["b", 0]]);
});

test("a command that cannot start is a red with exit 127", async () => {
  const g = await runGate({ cwd: tmp(), logDir: tmp(), label: "absent", commands: [{ name: "absent", cmd: ["peb-no-such-command-anywhere"] }] });
  assert.equal(g.ok, false);
  assert.equal(g.failed.code, 127);
});

test("project.testCounts reads Vitest's Tests line, and returns null for output with none", () => {
  const out = "\x1b[31m FAIL \x1b[39m src/a.test.ts > s > n\n Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 99 passed | 2 skipped (102)\n";
  assert.deepEqual(project.testCounts(out), { passed: 99, failed: 1, skipped: 2, failing: ["src/a.test.ts > s > n"], summary: "1 failed | 99 passed | 2 skipped (102)" });
  assert.equal(project.testCounts("tsc: no errors"), null);
});

test("project.testCounts reads a recorded red Vitest run: its counts and both failing tests, once each", () => {
  assert.deepEqual(project.testCounts(RED_VITEST_OUTPUT), {
    passed: 2,
    failed: 2,
    skipped: 1,
    failing: ["src/red.test.ts > totals > sums to 1250 minor units", "src/red.test.ts > parser > reads the currency"],
    summary: "2 failed | 2 passed | 1 skipped (5)",
  });
});

test("project.shellCall names this project's test and check commands and nothing else", () => {
  assert.deepEqual(project.shellCall("pnpm test"), { kind: "tests", what: "pnpm test" });
  assert.deepEqual(project.shellCall("pnpm typecheck"), { kind: "check", what: "pnpm typecheck" });
  assert.deepEqual(project.shellCall('node --test ".claude/hooks/*.test.mjs"'), { kind: "tests", what: 'node --test ".claude/hooks/*.test.mjs"' });
  assert.equal(project.shellCall("git status"), null);
});
