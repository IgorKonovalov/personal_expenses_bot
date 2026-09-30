import { parseLocalDate, type LocalDate } from './time.js';

// A date named by the last word of an expense text, resolved against the user's local today.
export type DateSuffix =
  | { readonly kind: 'none' }
  | { readonly kind: 'date'; readonly date: LocalDate }
  // A literal `dd.mm.yyyy` after today: the expense is refused, not re-dated.
  | { readonly kind: 'future'; readonly date: LocalDate };

const RELATIVE_DAYS: Readonly<Record<string, number>> = { вчера: 1, позавчера: 2 };

// `d.mm` / `dd.mm`: the month is exactly two digits, so `1.5` stays a description word.
const DAY_MONTH = /^(\d{1,2})\.(\d{2})$/;
const DAY_MONTH_YEAR = /^(\d{1,2})\.(\d{2})\.(\d{4})$/;

// Year inference looks back at most this far: `29.02` in a year after a leap year resolves to
// the last leap year, and no shape needs more than 8 years (the 2100 gap).
const MAX_YEARS_BACK = 8;

// `вчера` / `позавчера` count back from today. `dd.mm` is the most recent such date not after
// today. `dd.mm.yyyy` is literal. A word of the right shape that is no calendar date (`31.02`)
// is none, so it stays part of the description.
export function parseDateSuffix(word: string, today: LocalDate): DateSuffix {
  const back = RELATIVE_DAYS[word.toLowerCase()];
  if (back !== undefined) return { kind: 'date', date: addDays(today, -back) };

  const full = DAY_MONTH_YEAR.exec(word);
  if (full !== null) {
    const date = localDate(Number(full[3]), Number(full[2]), Number(full[1]));
    if (date === undefined) return { kind: 'none' };
    return date > today ? { kind: 'future', date } : { kind: 'date', date };
  }

  const short = DAY_MONTH.exec(word);
  if (short !== null) {
    const thisYear = Number(today.slice(0, 4));
    for (let year = thisYear; year >= thisYear - MAX_YEARS_BACK; year -= 1) {
      const date = localDate(year, Number(short[2]), Number(short[1]));
      if (date !== undefined && date <= today) return { kind: 'date', date };
    }
  }
  return { kind: 'none' };
}

// `2026-09-30` minus one day is `2026-09-29`. Calendar arithmetic in UTC, where days are 24h.
export function addDays(date: LocalDate, days: number): LocalDate {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10) as LocalDate;
}

function localDate(year: number, month: number, day: number): LocalDate | undefined {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return parseLocalDate(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`);
}
