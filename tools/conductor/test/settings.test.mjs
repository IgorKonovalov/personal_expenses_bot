// The allowlist a conductor session runs under, read against what the conductor and its prompts ask
// of a session: every gate command and every command a prompt tells a session to run is allowed, a
// push is denied, and the project's secrets and user data stay unreadable.
//
// The matcher implements the rule forms settings.conductor.json uses and nothing more: `Tool` alone
// allows every call of that tool; `Bash(<pattern>)` matches the whole command, `*` matching any run
// of characters; `Read(./<path>)` matches a path relative to the lane root, `**` crossing directories
// and `*` staying inside one. A deny rule beats an allow rule.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { project } from "../project.mjs";
import { TOOL_DIR } from "./helpers.mjs";

const SETTINGS = JSON.parse(readFileSync(join(TOOL_DIR, "settings.conductor.json"), "utf8"));

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function ruleMatches(rule, tool, value) {
  if (rule === tool) return true;
  const m = rule.match(/^(\w+)\((.*)\)$/s);
  if (!m || m[1] !== tool) return false;
  if (tool === "Bash") return new RegExp(`^${escape(m[2]).replace(/\*/g, "[\\s\\S]*")}$`).test(value);
  const pattern = m[2].replace(/^\.\//, "");
  const re = escape(pattern).replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(value.replace(/^\.\//, ""));
}

/** "allow", "deny" or "ask" (no rule matched) for one tool call under the conductor settings. */
function decision(tool, value) {
  if (SETTINGS.permissions.deny.some((r) => ruleMatches(r, tool, value))) return "deny";
  if (SETTINGS.permissions.allow.some((r) => ruleMatches(r, tool, value))) return "allow";
  return "ask";
}

/** A gate step as a session would type it: an argument with a glob in it is quoted. */
const typed = (cmd) => cmd.map((a) => (/[\s*]/.test(a) ? `"${a}"` : a)).join(" ");

/** Every backticked `git`, `pnpm` or `node` command in the prompts, placeholders filled in. */
function promptCommands() {
  const dir = join(TOOL_DIR, "prompts");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/`((?:git|pnpm|node) [^`]+)`/g)) out.push({ file, command: m[1].replace(/<[^>]+>/g, "x") });
  }
  return out;
}

test("the matcher reads the rule forms it claims to", () => {
  assert.equal(ruleMatches("Bash(git push *)", "Bash", "git push origin main"), true);
  assert.equal(ruleMatches("Bash(git push)", "Bash", "git push origin main"), false);
  assert.equal(ruleMatches("Read(./data/**)", "Read", "data/2026/x.sqlite"), true);
  assert.equal(ruleMatches("Read(./.env)", "Read", ".env.example"), false);
  assert.equal(ruleMatches("Read", "Read", "anything"), true);
});

test("every gate command in project.mjs is allowed", () => {
  const commands = project.gate.map((c) => typed(c.cmd));
  assert.ok(commands.includes('node --test "tools/conductor/test/*.test.mjs"'), commands.join("\n"));
  for (const command of commands) assert.equal(decision("Bash", command), "allow", command);
});

test("every command the prompts tell a session to run is allowed", () => {
  const found = promptCommands();
  // The prompts name the gate, the merge and the close's link check; an empty scan would pass vacuously.
  for (const want of ["pnpm test", "git merge --no-edit main", "node scripts/check-doc-links.mjs"]) {
    assert.ok(found.some((c) => c.command === want), `the prompts name ${want}`);
  }
  for (const { file, command } of found) assert.equal(decision("Bash", command), "allow", `${file}: ${command}`);
});

test("git push is denied, bare and with a remote and branch", () => {
  assert.equal(decision("Bash", "git push"), "deny");
  assert.equal(decision("Bash", "git push origin main"), "deny");
});

test("the project's secrets and user data are unreadable", () => {
  assert.equal(decision("Read", "data/x.sqlite"), "deny");
  assert.equal(decision("Read", ".env"), "deny");
  assert.equal(decision("Read", "src/domain/money.ts"), "allow");
});

test("a background watcher, the web and an rm leaving the lane are denied", () => {
  for (const tool of ["Monitor", "WebFetch"]) assert.equal(decision(tool, ""), "deny", tool);
  assert.equal(decision("Bash", "rm -rf ../other-lane"), "deny");
  assert.equal(decision("Bash", "rm -rf /home"), "deny");
  assert.equal(decision("Bash", "rm scratch.txt"), "allow");
});

// F8: a read-only `git grep` whose pattern holds backticks and Cyrillic was denied in a session.
// The allowlist permits it, so the denial came from the CLI's own guard against shell substitution
// in a command, and the prompts send such patterns to the Grep tool instead.
test("the allowlist permits a git grep whose quoted pattern holds backticks and Cyrillic", () => {
  assert.equal(decision("Bash", 'git grep -n "`Изменить`"'), "allow");
});
