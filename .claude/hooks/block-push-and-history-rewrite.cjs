#!/usr/bin/env node
// PreToolUse hook: deny `git push`, `git reset --hard`, `git rebase`,
// `git commit --amend` and `git filter-branch`.
//
// The push is the owner's (the last human checkpoint, and here it also
// deploys); history is never rewritten. See CLAUDE.md -> "Commit hygiene".
//
// What is judged is the COMMAND POSITION of each simple command, not a
// substring: the line is split on shell separators outside quotes, heredoc
// bodies are dropped first, and a `bash -c "..."` wrapper is unwrapped and
// judged too. So a commit message that mentions `git push`, and
// `git stash push` / `git log origin/main`, all pass.

const { readFileSync } = require("fs");

function dropHeredocBodies(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "$3");
}

// Splits on && || ; | & and newlines that sit outside single or double quotes.
function splitOutsideQuotes(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // A redirection (`2>&1`, `&>`) is not a separator.
      if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = "";
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

const WRAPPER = /^(?:bash|sh|zsh|dash)\s+(?:-\w+\s+)*-\w*c\s+(["'])([\s\S]*)\1\s*$/;

function simpleCommands(cmd, depth = 0) {
  const result = [];
  for (const raw of splitOutsideQuotes(dropHeredocBodies(cmd))) {
    let seg = raw.trim().replace(/^[({!\s]+/, "");
    seg = seg.replace(/^(?:\w+=\S*\s+)+/, "").replace(/^(?:time|exec|command)\s+/, "");
    if (!seg) continue;
    const wrapped = depth < 3 && seg.match(WRAPPER);
    if (wrapped) result.push(...simpleCommands(wrapped[2], depth + 1));
    else result.push(seg);
  }
  return result;
}

const GIT =
  /^git((?:\s+(?:(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)|--no-pager|-P))*)\s+([\w-]+)(.*)$/s;

function offending(seg) {
  const m = seg.match(GIT);
  if (!m) return null;
  const sub = m[2];
  const rest = m[3].replace(/"[^"]*"|'[^']*'/g, '""');
  if (sub === "push" || sub === "rebase" || sub === "filter-branch") return `git ${sub}`;
  if (sub === "reset" && /(^|\s)--hard(\s|$)/.test(rest)) return "git reset --hard";
  if (sub === "commit" && /(^|\s)--amend(\s|=|$)/.test(rest)) return "git commit --amend";
  return null;
}

function decide(cmd) {
  return simpleCommands(cmd).map(offending).find(Boolean) || null;
}

module.exports = { simpleCommands, offending, decide };

if (require.main === module) {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const hit = decide((input.tool_input && input.tool_input.command) || "");
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
          `Blocked "${hit}". Pushing is the repository owner's, and history is never ` +
          `rewritten here: no push, reset --hard, rebase, commit --amend or filter-branch. ` +
          `Make a new commit instead of amending; leave the push to the owner. ` +
          `See CLAUDE.md -> "Commit hygiene".`,
      },
    }),
  );
  process.exit(0);
}
