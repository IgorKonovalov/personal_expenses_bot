import type { LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { previous, type Period } from '../domain/periods.js';
import { isLocked } from './ledgerKeys.js';
import { ledgerPeriodSummary } from './periodSummary.js';

// How many periods a chart's trend shows: the shown one and the ones before it.
export const TREND_PERIODS = 6;

// One trend bar: a period and its total converted into the ledger's currency (ADR-0022), 0 for
// a period with nothing in or converted into that currency.
export interface TrendPoint {
  readonly period: Period;
  readonly totalMinor: number;
  // True when the total holds converted foreign spending.
  readonly approximate: boolean;
}

// The converted totals of `period` and the periods before it, oldest first, each read through
// the same ledgerPeriodSummary the text screen pages with, so a bar equals the total shown after
// paging to its period. Undefined when any of them can't be read: the user is no longer a
// member, or the ledger is sealed and locked.
export function periodTrend(
  deps: Parameters<typeof ledgerPeriodSummary>[0],
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly period: Period;
    readonly now: Date;
  },
): readonly TrendPoint[] | undefined {
  const periods = [input.period];
  while (periods.length < TREND_PERIODS) periods.unshift(previous(periods[0] ?? input.period));
  const points: TrendPoint[] = [];
  for (const period of periods) {
    const summary = ledgerPeriodSummary(deps, { ...input, period });
    if (summary === undefined || isLocked(summary)) return undefined;
    const [first] = summary.currencies;
    points.push({
      period,
      totalMinor: first?.currency === summary.ledger.defaultCurrency ? first.totalMinor : 0,
      approximate: summary.convertedFrom.length > 0,
    });
  }
  return points;
}
