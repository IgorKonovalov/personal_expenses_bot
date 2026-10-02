import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A sealed row's amount_minor is NULL (ADR-0020), so SQL that aggregates it silently undercounts a
// sealed ledger. Totals go through the decrypting read path and the domain instead.
const AGGREGATE_OF_AMOUNT = /\b(sum|total|avg|min|max|group_concat)\s*\([^)]*amount_minor/i;

const dir = fileURLToPath(new URL('./', import.meta.url));

// Every non-test source under src/db/, migrations included.
const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|sql)$/.test(f) && !f.endsWith('.test.ts'))
  .sort();

describe('the db layer', () => {
  it('reads its sources, migrations included', () => {
    expect(sources).toContain('expenses.ts');
    expect(sources.some((f) => f.endsWith('.sql'))).toBe(true);
  });

  it('the guard matches an aggregate over amount_minor', () => {
    expect('SELECT SUM(e.amount_minor) FROM expenses e').toMatch(AGGREGATE_OF_AMOUNT);
    expect('SELECT e.amount_minor FROM expenses e').not.toMatch(AGGREGATE_OF_AMOUNT);
  });

  it.each(sources)('%s has no SQL aggregate over amount_minor', (file) => {
    expect(readFileSync(`${dir}${file}`, 'utf8')).not.toMatch(AGGREGATE_OF_AMOUNT);
  });
});
