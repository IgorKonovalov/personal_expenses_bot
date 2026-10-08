// `pnpm docs:chats`: runs every scenario in scenarios/ through the real bot and writes its
// transcript to site/src/generated/chats/<name>.json for the docs site (ADR-0048). A scenario
// that throws fails the run, and with it the Pages build.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScenario, type Scenario } from './scenario.js';

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, 'scenarios');
const outDir = join(here, '..', '..', 'site', 'src', 'generated', 'chats');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const files = readdirSync(scenariosDir)
  .filter((file) => file.endsWith('.ts'))
  .sort();
const names = new Set<string>();
for (const file of files) {
  const module = (await import(pathToFileURL(join(scenariosDir, file)).href)) as {
    default: Scenario;
  };
  const scenario = module.default;
  if (names.has(scenario.name)) throw new Error(`scenario ${scenario.name}: named twice`);
  names.add(scenario.name);
  const transcript = await runScenario(scenario);
  writeFileSync(join(outDir, `${scenario.name}.json`), `${JSON.stringify(transcript, null, 2)}\n`);
}
console.log(`docs:chats: ${names.size} transcripts in site/src/generated/chats/`);
