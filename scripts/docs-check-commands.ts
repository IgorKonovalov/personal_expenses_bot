// `pnpm docs:check`: every command a user sees in the bot's menu, in a private chat or a group,
// is mentioned as `/<command>` on some page of the docs site's guide (ADR-0048). Exits non-zero
// naming each command no page mentions. The admin-only commands are exempt: the guide doesn't
// cover them.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messages } from '../src/bot/messages.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guideDir = join(root, 'site', 'src', 'content', 'docs', 'guide');

// The commands in `commands` none of `pages` mentions as `/<command>`, a longer command
// (`/tags` for `tag`) not counting.
function missingCommands(commands: readonly string[], pages: readonly string[]): string[] {
  return commands.filter((command) => {
    const mention = new RegExp(`/${command}(?![A-Za-z0-9_])`);
    return !pages.some((page) => mention.test(page));
  });
}

const pages = readdirSync(guideDir)
  .filter((file) => file.endsWith('.mdx'))
  .map((file) => readFileSync(join(guideDir, file), 'utf8'));
const commands = [
  ...new Set([...messages.commands, ...messages.groupCommands].map(({ command }) => command)),
];
const missing = missingCommands(commands, pages);
for (const command of missing) {
  console.error(`docs:check: /${command} is on no page of site/src/content/docs/guide/`);
}
if (missing.length > 0) process.exit(1);
console.log('docs:check: every command is in the guide');
