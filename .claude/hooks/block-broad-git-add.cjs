#!/usr/bin/env node
// PreToolUse hook: deny broad `git add` (-A / --all / bare "." / ":/").
//
// Broad staging sweeps stray untracked files (a local .env, a data/ dump) and
// another session's in-progress work into a commit. Stage explicit paths
// instead. See CLAUDE.md -> "Commit hygiene".
//
// Wired up in .claude/settings.json under hooks.PreToolUse with matcher "Bash".
// The matcher filters by tool name only; this script decides whether to deny.

const { readFileSync } = require("fs");

function offending(cmd) {
  // Inspect every `git add ...` occurrence, even inside a compound command line
  // like `pnpm test && git add -A && git commit`.
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const m = seg.match(/\bgit\s+add\b(.*)$/);
    if (!m) continue;
    const args = m[1];
    if (
      /(^|\s)(-A|--all|--no-ignore-removal)(\s|$)/.test(args) ||
      /(^|\s)\.(\/)?(\s|$)/.test(args) ||
      /(^|\s):\/(\s|$)/.test(args)
    ) {
      return seg.trim();
    }
  }
  return null;
}

module.exports = { offending };

if (require.main === module) {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const hit = offending((input.tool_input && input.tool_input.command) || "");
  if (!hit) {
    process.stdout.write("{}");
    process.exit(0);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked broad staging: "${hit}". "git add -A / --all / . / :/" sweeps untracked ` +
          `and cross-session files into the commit. Stage only the files you changed, by ` +
          `explicit path. Run "git status" first if unsure. See CLAUDE.md -> "Commit hygiene".`,
      },
    }),
  );
  process.exit(0);
}
