import { addDays } from './dateText.js';
import { parseLocalDate, type LocalDate } from './time.js';

// A report period of local dates, both ends inclusive: a Monday-to-Sunday week or a calendar
// month. Local-date strings compare and step without any DST arithmetic.
export interface Period {
  readonly kind: 'week' | 'month';
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export function weekOf(date: LocalDate): Period {
  // getUTCDay is 0 on Sunday; the week starts on Monday.
  const fromMonday = (dayOfWeek(date) + 6) % 7;
  const from = addDays(date, -fromMonday);
  return { kind: 'week', from, to: addDays(from, 6) };
}

export function monthOf(date: LocalDate): Period {
  const [year = 0, month = 1] = date.split('-').map(Number);
  // Day 0 of the next month is this month's last day.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = date.slice(0, 8);
  return {
    kind: 'month',
    from: `${prefix}01` as LocalDate,
    to: `${prefix}${String(last).padStart(2, '0')}` as LocalDate,
  };
}

export function periodOf(kind: Period['kind'], date: LocalDate): Period {
  return kind === 'week' ? weekOf(date) : monthOf(date);
}

export function previous(period: Period): Period {
  return periodOf(period.kind, addDays(period.from, -1));
}

export function next(period: Period): Period {
  return periodOf(period.kind, addDays(period.to, 1));
}

// A budget period of local dates, both ends inclusive (ADR-0017).
export interface DateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

// The budget period holding `date` for a period starting on day `startDay` (1..31) of a month.
// A month too short for `startDay` starts its period on its last day. The period runs to the day
// before the next one starts. Start day 1 gives monthOf's calendar months.
export function budgetPeriodOf(date: LocalDate, startDay: number): DateRange {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const thisStart = clampedDay(year, month, startDay);
  const [fromYear, fromMonth] = day >= thisStart ? [year, month] : shiftMonth(year, month, -1);
  const [nextYear, nextMonth] = shiftMonth(fromYear, fromMonth, 1);
  const from = isoDate(fromYear, fromMonth, clampedDay(fromYear, fromMonth, startDay));
  const nextFrom = isoDate(nextYear, nextMonth, clampedDay(nextYear, nextMonth, startDay));
  return { from, to: addDays(nextFrom, -1) };
}

function lastDayOf(year: number, month: number): number {
  // Day 0 of the next month is this month's last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampedDay(year: number, month: number, startDay: number): number {
  return Math.min(startDay, lastDayOf(year, month));
}

// `month` is 1-based; returns [year, month] moved by `delta` months.
function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), (index % 12) + 1];
}

function isoDate(year: number, month: number, day: number): LocalDate {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as LocalDate;
}

// A week by its Monday (`2026-09-28`) or a month by `YYYY-MM` (`2026-09`). Anything else,
// including a week keyed by another weekday, is undefined.
export function parsePeriod(kind: Period['kind'], key: string): Period | undefined {
  if (kind === 'month') {
    if (!/^\d{4}-\d{2}$/.test(key)) return undefined;
    const first = parseLocalDate(`${key}-01`);
    return first === undefined ? undefined : monthOf(first);
  }
  const monday = parseLocalDate(key);
  if (monday === undefined) return undefined;
  const week = weekOf(monday);
  return week.from === monday ? week : undefined;
}

// The key parsePeriod reads back.
export function periodKey(period: Period): string {
  return period.kind === 'month' ? period.from.slice(0, 7) : period.from;
}

function dayOfWeek(date: LocalDate): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
