import { describe, expect, it } from 'vitest';
import {
  dueInstant,
  isoWeekday,
  monthlyOn,
  nextOccurrence,
  weeklyOn,
  yearlyOn,
} from './schedule.js';
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

// The dates a schedule falls on after `from`, `count` of them.
function run(schedule: ReturnType<typeof monthlyOn>, from: string, count: number): string[] {
  const dates: string[] = [];
  let date = d(from);
  for (let i = 0; i < count; i++) {
    date = nextOccurrence(schedule, date);
    dates.push(date);
  }
  return dates;
}

describe('nextOccurrence, short months', () => {
  it('a day-31 rule from 31 January falls on 28 February, 31 March, then 30 April', () => {
    expect(run(monthlyOn(d('2026-01-31')), '2026-01-31', 3)).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });
});

describe('nextOccurrence, yearly', () => {
  it('a 29 February rule falls on 28 February in common years and 29 February in 2028', () => {
    expect(run(yearlyOn(d('2024-02-29')), '2024-02-29', 4)).toEqual([
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
  });

  it('falls later this year when the day is still ahead', () => {
    expect(nextOccurrence(yearlyOn(d('2025-10-15')), d('2026-10-02'))).toBe('2026-10-15');
  });
});

describe('nextOccurrence, weekly', () => {
  it('a rule from Wednesday 7 October falls on the 14th, then the 21st', () => {
    expect(weeklyOn(d('2026-10-07'))).toEqual({ kind: 'weekly', weekday: 3 });
    expect(run(weeklyOn(d('2026-10-07')), '2026-10-07', 2)).toEqual(['2026-10-14', '2026-10-21']);
  });

  it('falls later this week when the weekday is still ahead', () => {
    // Saturday from a Thursday.
    expect(nextOccurrence(weeklyOn(d('2026-10-24')), d('2026-10-22'))).toBe('2026-10-24');
  });

  it('numbers Sunday 7', () => {
    expect(isoWeekday(d('2026-10-25'))).toBe(7);
  });
});

describe('dueInstant', () => {
  it('is 09:00 local: 08:00Z in Belgrade in November', () => {
    expect(dueInstant(d('2026-11-01'), 'Europe/Belgrade').toISOString()).toBe(
      '2026-11-01T08:00:00.000Z',
    );
  });

  it('moves with DST: 07:00Z on 24 October (CEST), 08:00Z on 31 October (CET)', () => {
    expect(dueInstant(d('2026-10-24'), 'Europe/Belgrade').toISOString()).toBe(
      '2026-10-24T07:00:00.000Z',
    );
    expect(dueInstant(d('2026-10-31'), 'Europe/Belgrade').toISOString()).toBe(
      '2026-10-31T08:00:00.000Z',
    );
  });

  it('is 04:00Z in Asia/Almaty (UTC+5)', () => {
    expect(dueInstant(d('2026-11-01'), 'Asia/Almaty').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
  });
});
