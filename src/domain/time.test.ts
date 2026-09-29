import { describe, expect, it } from 'vitest';
import { localDateOf, localDayWindow, parseLocalDate, type LocalDate } from './time.js';

describe('localDateOf', () => {
  const instant = new Date('2026-09-29T22:30:00Z');

  it('is the next day in Europe/Belgrade (CEST, UTC+2)', () => {
    expect(localDateOf(instant, 'Europe/Belgrade')).toBe('2026-09-30');
  });

  it('is the same day in Etc/UTC', () => {
    expect(localDateOf(instant, 'Etc/UTC')).toBe('2026-09-29');
  });
});

describe('localDayWindow', () => {
  it('spans 25 hours on the EU DST-end day in Europe/Belgrade', () => {
    const { start, end } = localDayWindow('2026-10-25' as LocalDate, 'Europe/Belgrade');
    expect(start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('spans 23 hours on the EU DST-start day in Europe/Belgrade', () => {
    const { start, end } = localDayWindow('2026-03-29' as LocalDate, 'Europe/Belgrade');
    expect(start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
});

describe('parseLocalDate', () => {
  it('accepts a real calendar date and rejects others', () => {
    expect(parseLocalDate('2026-09-30')).toBe('2026-09-30');
    expect(parseLocalDate('2026-02-30')).toBeUndefined();
    expect(parseLocalDate('2026-9-30')).toBeUndefined();
  });
});
