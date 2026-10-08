// `pnpm docs:check`, two checks on the docs site (ADR-0048), each failing the run by name:
// - every command a user sees in the bot's menu, in a private chat or a group, is mentioned as
//   `/<command>` on some page of the guide. The admin-only commands are exempt: the guide doesn't
//   cover them.
// - every `docs/adrs/…` file an architecture page links to on GitHub exists in this repository.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messages } from '../src/bot/messages.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'site', 'src', 'content', 'docs');

function pagesIn(section: string): { readonly file: string; readonly text: string }[] {
  const dir = join(docsDir, section);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.mdx'))
    .map((file) => ({ file: `${section}/${file}`, text: readFileSync(join(dir, file), 'utf8') }));
}

const failures: string[] = [];

// The commands none of the guide's pages mentions as `/<command>`, a longer command (`/tags`
// for `tag`) not counting.
const guide = pagesIn('guide');
const commands = new Set(
  [...messages.commands, ...messages.groupCommands].map(({ command }) => command),
);
for (const command of commands) {
  const mention = new RegExp(`/${command}(?![A-Za-z0-9_])`);
  if (!guide.some((page) => mention.test(page.text))) {
    failures.push(`/${command} is on no page of site/src/content/docs/guide/`);
  }
}

// The ADR files the architecture pages link to, by their path in the repository.
for (const page of pagesIn('architecture')) {
  for (const [path] of page.text.matchAll(/docs\/adrs\/[^\s)"'>#]+/g)) {
    if (!existsSync(join(root, path))) {
      failures.push(`${page.file} links to ${path}, which is gone`);
    }
  }
}

for (const failure of failures) console.error(`docs:check: ${failure}`);
if (failures.length > 0) process.exit(1);
console.log('docs:check: every command is in the guide, every ADR link resolves');
