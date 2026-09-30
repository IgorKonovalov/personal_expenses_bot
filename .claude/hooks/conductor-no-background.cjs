#!/usr/bin/env node
// PreToolUse hook: in a conductor-started session (CONDUCTOR_SESSION=1), deny a `Bash` call that
// carries `run_in_background`. Outside the conductor the variable is unset and every call passes.
//
// Nothing re-invokes a headless `claude -p` session. A session that starts a command in the
// background and ends its turn exits, the command is killed, and its result is lost after the
// commits already made have landed (ADR-0010). A long command runs in the foreground, bounded by the
// session's own timeout. The prompts say it, the conductor settings deny `Monitor`, this hook
// refuses the call, and tools/conductor/lib/step.mjs parks a session that got one started anyway.
//
// It is also the conductor's proof that project hooks run under `-p`: when CONDUCTOR_SESSION=1 and
// CONDUCTOR_HOOK_LOG names a file, every call appends one JSON line to it, whatever the decision. A
// session that made a shell call and left no line is parked `cli_contract`. The append never
// changes the decision and never fails the hook.
//
// Wired up in .claude/settings.json under hooks.PreToolUse with matcher "Bash".

const { appendFileSync, readFileSync } = require('fs');

/** True when a tool call asks for backgrounding. The CLI accepts the boolean and the string form. */
function wantsBackground(toolInput) {
  const v = toolInput?.run_in_background;
  return v === true || v === 'true';
}

function decide(input, env) {
  return env.CONDUCTOR_SESSION === '1' && wantsBackground(input.tool_input);
}

module.exports = { decide, wantsBackground };

if (require.main === module) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const deny = decide(input, process.env);
  if (process.env.CONDUCTOR_SESSION === '1' && process.env.CONDUCTOR_HOOK_LOG) {
    try {
      appendFileSync(
        process.env.CONDUCTOR_HOOK_LOG,
        JSON.stringify({
          hook: 'conductor-no-background',
          tool: input.tool_name ?? null,
          decision: deny ? 'deny' : 'allow',
          at: new Date().toISOString(),
        }) + '\n',
      );
    } catch {}
  }
  if (!deny) {
    process.stdout.write('{}');
    process.exit(0);
  }
  const command = String(input.tool_input?.command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked "${command.slice(0, 80)}": a conductor-started session never runs a command in the ` +
          `background. Nothing re-invokes a headless session, so a backgrounded command is killed when ` +
          `the turn ends and its result is lost. Run it in the foreground (ADR-0010).`,
      },
    }),
  );
  process.exit(0);
}
