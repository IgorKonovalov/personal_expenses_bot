import type { Db } from '../db/connection.js';
import {
  expenseDaysThrough,
  listFxDayFetches,
  setFxDay,
  storeFxList,
  type FxList,
} from '../db/fxRates.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import type { Logger } from '../logger.js';

// NBS lists are dated in Belgrade (ADR-0022).
const NBS_TIMEZONE = 'Europe/Belgrade';
// Days fetched per tick at most; a long backlog drains over several ticks, newest first.
const MAX_DAYS_PER_TICK = 31;

export type RateListFailure = 'timeout' | 'network' | 'http' | 'empty' | 'unparseable';

export type RateListOutcome =
  | { readonly kind: 'fetched'; readonly list: FxList }
  | { readonly kind: 'failed'; readonly reason: RateListFailure };

// The list in force on a Belgrade day; for a weekend or holiday that is an earlier day's list.
// Asked only for the days daysOwed returns, newest first.
export type RateListFetcher = (day: LocalDate, signal: AbortSignal) => Promise<RateListOutcome>;

export interface FetchRatesDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly fetchList: RateListFetcher;
}

// Which days a tick fetches: each Belgrade date that has a non-deleted expense, up to today, plus
// today itself, that has no fx_days row or whose row was fetched on or before that same Belgrade
// date (its list may not have been out yet). Newest first, at most MAX_DAYS_PER_TICK.
export function daysOwed(db: Db, now: Date): LocalDate[] {
  const today = localDateOf(now, NBS_TIMEZONE);
  const days = expenseDaysThrough(db, today);
  if (days.at(-1) !== today) days.push(today);
  const [oldest = today] = days;
  const fetches = listFxDayFetches(db, oldest, today);
  return days
    .filter((day) => {
      const fetchedAt = fetches.get(day);
      return fetchedAt === undefined || localDateOf(fetchedAt, NBS_TIMEZONE) <= day;
    })
    .reverse()
    .slice(0, MAX_DAYS_PER_TICK);
}

// One tick: fetches each owed day in turn and stores its list. A failed day is logged and left
// owed for the next tick. Stops early once `signal` aborts.
export async function fetchRates(
  { db, logger, fetchList }: FetchRatesDeps,
  { now, signal }: { readonly now: Date; readonly signal: AbortSignal },
): Promise<{ readonly fetched: number; readonly failed: number }> {
  let fetched = 0;
  let failed = 0;
  for (const day of daysOwed(db, now)) {
    if (signal.aborted) break;
    const outcome = await fetchList(day, signal);
    if (outcome.kind === 'failed') {
      failed++;
      logger.warn({ day, reason: outcome.reason }, 'fx fetch failed');
      continue;
    }
    const { list } = outcome;
    db.transaction(() => {
      storeFxList(db, list, now);
      setFxDay(db, day, list.listDate, now);
    })();
    fetched++;
    logger.debug({ day, listDate: list.listDate, listNumber: list.listNumber }, 'fx list stored');
  }
  return { fetched, failed };
}
