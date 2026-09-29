#!/usr/bin/env node
// Asserts that every relative markdown link in the repo resolves to a file.
//
// Run at every plan close (architect close ceremony): moving a plan into
// docs/plans/done/ breaks inbound links to its old path and every `../` link
// inside it. Fragments (#anchor) are stripped, not validated. External links
// (scheme:, //host) and pure fragments are skipped, as are fenced code blocks
// and inline code spans. Exit 0 = all resolve, 1 = broken links printed as
// `file:line -> target`.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", "data", "worktrees"]);

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* markdownFiles(join(dir, entry.name));
    } else if (entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

const LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*(\S+)/g;

const broken = [];
let checked = 0;
for (const file of markdownFiles(root)) {
  let inFence = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return;
      const text = line.replace(/`[^`]*`/g, "");
      for (const m of text.matchAll(LINK)) {
        const target = m[1] || m[2];
        if (!target || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
        const path = decodeURIComponent(target.split("#")[0]);
        if (!path) continue;
        checked++;
        const abs = path.startsWith("/") ? join(root, path) : resolve(dirname(file), path);
        if (!existsSync(abs) || (path.endsWith("/") && !statSync(abs).isDirectory())) {
          broken.push(`${relative(root, file)}:${i + 1} -> ${target}`);
        }
      }
    });
}

if (broken.length) {
  console.error(`check-doc-links: ${broken.length} broken relative link(s):`);
  for (const b of broken) console.error(`  ${b}`);
  console.error(
    "After a `git mv` into docs/plans/done/: inbound `plans/NNNN-...` -> `plans/done/NNNN-...`; " +
      "outbound links inside the moved plan gain one `../`.",
  );
  process.exit(1);
}
console.log(`check-doc-links: ${checked} relative link(s) resolve.`);
