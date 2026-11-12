import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GENERATED_PATH, PROGRAMS, generatedSource } from '../../../scripts/build-widgets.js';
import { WIDGET_PROGRAMS } from './programs.generated.js';

// Telegram's limits on a widget's HTML (ADR-0053): 32768 bytes, and 4096 bytes after zlib at
// level 9. Node's zlib can differ from the server's by a few dozen bytes either way, so a
// program near the gate is measured again with Python's zlib, which counts as the server does.
const MAX_HTML_BYTES = 32768;
const MAX_DEFLATED_BYTES = 4096;

describe('widget programs', () => {
  it.each(PROGRAMS)('%s fits the size limits', (name) => {
    const html = WIDGET_PROGRAMS[name];
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(MAX_HTML_BYTES);
    expect(deflateSync(html, { level: 9 }).length).toBeLessThanOrEqual(MAX_DEFLATED_BYTES);
  });

  it('the committed programs.generated.ts is what pnpm build:widgets writes', async () => {
    expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(await generatedSource());
  });

  it('holds exactly the programs the build knows', () => {
    expect(Object.keys(WIDGET_PROGRAMS)).toEqual([...PROGRAMS]);
  });
});
