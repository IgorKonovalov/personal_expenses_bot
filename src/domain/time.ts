import { TZDate } from '@date-fns/tz';
import { addDays, format } from 'date-fns';

// A calendar date in some timezone, `YYYY-MM-DD`.
export type LocalDate = string & { readonly __brand: 'LocalDate' };

export interface UtcWindow {
  // Inclusive.
  readonly start: Date;
  // Exclusive.
  readonly end: Date;
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  return format(new TZDate(instant.getTime(), timeZone), 'yyyy-MM-dd') as LocalDate;
}

export function parseLocalDate(raw: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return undefined;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
    ? (raw as LocalDate)
    : undefined;
}

// The UTC instants bounding a local calendar day. Days are 23 or 25 hours long across DST
// changes, so the end is the next local midnight, never start + 24h.
export function localDayWindow(date: LocalDate, timeZone: string): UtcWindow {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const start = new TZDate(year, month - 1, day, timeZone);
  const end = addDays(start, 1);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}
