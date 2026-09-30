// The conductor's own gate, run in a worktree after the implementer runs, after every fix round, on
// the close tip and after a re-merge. It does not trust any session's claim that the checks passed.
//
// The commands are project.mjs's `gate`, in order, stopping at the first failure. Which of them run
// depends on the stage (`gateForStage`): a step marked `afterClose` runs only on a tree a close
// produced. Each command's output is kept under state/gates/. The gate never retries a red: a flake
// is a defect to fix, and a retry would bury it.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { project } from "../project.mjs";

/** The project's gate, as fresh step objects a caller may annotate. */
export function defaultGate() {
  return project.gate.map((c) => ({ ...c, cmd: [...c.cmd] }));
}

/** The stages whose tree a close produced. Every other stage is `pre-review` or `fix-N`. */
export const AFTER_CLOSE_STAGES = new Set(["post-close", "remerge"]);

/** The commands the gate runs at `stage`: `afterClose` steps drop out before a close. */
export function gateForStage(stage, commands = defaultGate()) {
  return AFTER_CLOSE_STAGES.has(stage) ? commands : commands.filter((c) => !c.afterClose);
}

function runCommand(cmd, cwd, env) {
  return new Promise((done) => {
    const [bin, ...args] = cmd;
    let output = "";
    const collect = (d) => {
      output += d;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    const start = (shell) => {
      const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      const child = shell
        ? spawn(cmd.map(quote).join(" "), { cwd, env: { ...process.env, ...env }, shell: true })
        : spawn(bin, args, { cwd, env: { ...process.env, ...env } });
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      // Node emits `close` (code -4058 on Windows) after `error` for a child that never started, so a
      // child handed to the shell retry must not settle the result: the retried child does.
      let retried = false;
      child.on("error", (e) => {
        // A .cmd shim (pnpm, npm) is not spawnable without a shell on Windows.
        if (e.code === "ENOENT" && !shell && process.platform === "win32") {
          retried = true;
          start(true);
        } else done({ code: 127, output: output + `\n${e.message}` });
      });
      child.on("close", (code) => {
        if (!retried) done({ code: code ?? 1, output });
      });
    };
    start(false);
  });
}

/**
 * Runs the gate. Resolves to
 *   { ok, ran: [names], commands: [{ name, code, ms }], failed?: { name, code, log, tail, tests } }.
 * `onCommandStart(command)` and `onCommandEnd(command, { code, ms, output })` bracket each command.
 * `tests` on a failure is the failing test names project.mjs reads out of that command's output.
 */
export async function runGate({ cwd, commands = defaultGate(), logDir, label, onCommandStart, onCommandEnd }) {
  mkdirSync(logDir, { recursive: true });
  const ran = [];
  const timed = [];
  for (const [i, c] of commands.entries()) {
    const t0 = Date.now();
    onCommandStart?.(c);
    const r = await runCommand(c.cmd, cwd, c.env ?? {});
    const ms = Date.now() - t0;
    const log = join(logDir, `${label}-${String(i).padStart(2, "0")}-${c.name.replace(/[^\w.-]+/g, "_")}.log`);
    writeFileSync(log, r.output);
    ran.push(c.name);
    timed.push({ name: c.name, code: r.code, ms });
    onCommandEnd?.(c, { code: r.code, ms, output: r.output });
    if (r.code !== 0) {
      return {
        ok: false,
        ran,
        commands: timed,
        failed: { name: c.name, code: r.code, log, tail: r.output.trim().split("\n").slice(-15).join("\n"), tests: project.failingTests(r.output) },
      };
    }
  }
  return { ok: true, ran, commands: timed };
}
