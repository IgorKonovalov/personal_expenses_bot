import { TZDate } from '@date-fns/tz';
import type { LocalDate } from './time.js';

// The schedule of a recurring rule (ADR-0031): which local dates it falls on. Dates are calendar
// dates; the instant a date fires at is computed per tick in the ledger's current timezone.

export type Schedule = { readonly kind: 'monthly'; readonly day: number };

// Every occurrence fires at this local hour (ADR-0031).
export const FIRING_HOUR = 9;

// A monthly schedule on the date's day of the month.
export function monthlyOn(date: LocalDate): Schedule {
  return { kind: 'monthly', day: partsOf(date).day };
}

// The first date strictly after `after` that the schedule falls on. A monthly day past the end
// of a shorter month falls on its last day; the stored day stays, so the 31st comes back.
export function nextOccurrence(schedule: Schedule, after: LocalDate): LocalDate {
  const { year, month } = partsOf(after);
  const sameMonth = clampedDate(year, month, schedule.day);
  if (sameMonth > after) return sameMonth;
  return month === 12
    ? clampedDate(year + 1, 1, schedule.day)
    : clampedDate(year, month + 1, schedule.day);
}

// FIRING_HOUR on the date, in the zone: across a DST change the UTC instant moves with it.
export function dueInstant(date: LocalDate, timeZone: string): Date {
  const { year, month, day } = partsOf(date);
  return new Date(new TZDate(year, month - 1, day, FIRING_HOUR, 0, timeZone).getTime());
}

function partsOf(date: LocalDate): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampedDate(year: number, month: number, day: number): LocalDate {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const shown = Math.min(day, daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(shown, 2)}` as LocalDate;
}
