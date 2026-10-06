import { describe, expect, it } from 'vitest';
import { dueInstant, monthlyOn, nextOccurrence } from './schedule.js';
import type { LocalDate } from './time.js';

const d = (s: string) => s as LocalDate;

describe('nextOccurrence, monthly', () => {
  it('falls on the expense day of the next month', () => {
    expect(nextOccurrence(monthlyOn(d('2026-10-01')), d('2026-10-02'))).toBe('2026-11-01');
  });

  it('falls later this month when the day is still ahead', () => {
    expect(nextOccurrence(monthlyOn(d('2026-09-15')), d('2026-10-02'))).toBe('2026-10-15');
  });

  it('is strictly after the date it starts from', () => {
    expect(nextOccurrence(monthlyOn(d('2026-11-01')), d('2026-11-01'))).toBe('2026-12-01');
  });

  it('crosses the year', () => {
    expect(nextOccurrence(monthlyOn(d('2026-12-01')), d('2026-12-01'))).toBe('2027-01-01');
  });
});

describe('dueInstant', () => {
  it('is 09:00 local: 08:00Z in Belgrade in November', () => {
    expect(dueInstant(d('2026-11-01'), 'Europe/Belgrade').toISOString()).toBe(
      '2026-11-01T08:00:00.000Z',
    );
  });
});
