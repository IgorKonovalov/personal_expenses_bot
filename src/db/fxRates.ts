import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import { addDays } from '../domain/dateText.js';
import type { Rate, RateOf } from '../domain/fx.js';
import type { LocalDate } from '../domain/time.js';
import type { Db } from './connection.js';

// NBS rate lists and the list in force on each day (ADR-0022).

export interface FxRate extends Rate {
  readonly currency: CurrencyCode;
}

export interface FxList {
  // The list's own date.
  readonly listDate: LocalDate;
  readonly listNumber: number;
  readonly rates: readonly FxRate[];
}

// How many days back a day with no stored list borrows the latest stored one (ADR-0022).
const BORROW_DAYS = 4;

// Replaces the list of its date and its rates, in one transaction.
export function storeFxList(db: Db, list: FxList, fetchedAt: Date): void {
  db.transaction(() => {
    db.prepare<[string, number, string]>(
      `INSERT INTO fx_lists (list_date, list_number, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (list_date) DO UPDATE SET
         list_number = excluded.list_number, fetched_at = excluded.fetched_at`,
    ).run(list.listDate, list.listNumber, fetchedAt.toISOString());
    db.prepare<[string]>('DELETE FROM fx_rates WHERE list_date = ?').run(list.listDate);
    const insert = db.prepare<[string, string, number, number]>(
      'INSERT INTO fx_rates (list_date, currency, unit, middle_e4) VALUES (?, ?, ?, ?)',
    );
    for (const rate of list.rates) {
      insert.run(list.listDate, rate.currency, rate.unit, rate.middleE4);
    }
  })();
}

// Points `day` at the list in force on it. The list must be stored.
export function setFxDay(db: Db, day: LocalDate, listDate: LocalDate, fetchedAt: Date): void {
  db.prepare<[string, string, string]>(
    `INSERT INTO fx_days (day, list_date, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (day) DO UPDATE SET
       list_date = excluded.list_date, fetched_at = excluded.fetched_at`,
  ).run(day, listDate, fetchedAt.toISOString());
}

// When each stored day in [from, to] was fetched.
export function listFxDayFetches(
  db: Db,
  from: LocalDate,
  to: LocalDate,
): ReadonlyMap<LocalDate, Date> {
  const rows = db
    .prepare<[string, string], { day: string; fetched_at: string }>(
      'SELECT day, fetched_at FROM fx_days WHERE day BETWEEN ? AND ?',
    )
    .all(from, to);
  return new Map(rows.map((row) => [row.day as LocalDate, new Date(row.fetched_at)]));
}

// The distinct occurred_on of non-deleted expenses, in any ledger, on or before `today`, oldest
// first: the days a rate is needed for.
export function expenseDaysThrough(db: Db, today: LocalDate): LocalDate[] {
  return db
    .prepare<[string], { day: string }>(
      `SELECT DISTINCT occurred_on AS day FROM expenses
       WHERE deleted_at IS NULL AND occurred_on <= ? ORDER BY occurred_on`,
    )
    .all(today)
    .map((row) => row.day as LocalDate);
}

// A lookup over the days [from, to], loaded once. A day with no fx_days row borrows the latest
// row up to BORROW_DAYS earlier; further back, or a currency the list lacks, is undefined.
export function rateLookupBetween(db: Db, from: LocalDate, to: LocalDate): RateOf {
  const rows = db
    .prepare<
      [string, string],
      { day: string; currency: string | null; unit: number | null; middle_e4: number | null }
    >(
      `SELECT d.day, r.currency, r.unit, r.middle_e4
       FROM fx_days d LEFT JOIN fx_rates r ON r.list_date = d.list_date
       WHERE d.day BETWEEN ? AND ?`,
    )
    .all(addDays(from, -BORROW_DAYS), to);
  const byDay = new Map<string, Map<CurrencyCode, Rate>>();
  for (const row of rows) {
    const rates = byDay.get(row.day) ?? new Map<CurrencyCode, Rate>();
    byDay.set(row.day, rates);
    const currency = row.currency === null ? undefined : toCurrencyCode(row.currency);
    if (currency === undefined || row.unit === null || row.middle_e4 === null) continue;
    rates.set(currency, { unit: row.unit, middleE4: row.middle_e4 });
  }
  return (currency, day) => {
    for (let back = 0; back <= BORROW_DAYS; back++) {
      const rates = byDay.get(addDays(day, -back));
      if (rates !== undefined) return rates.get(currency);
    }
    return undefined;
  };
}
