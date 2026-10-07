import type { LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import type { CategoryLine } from '../domain/aggregate.js';
import { addDays } from '../domain/dateText.js';
import { changeOf, periodDeltas, type CategoryDelta, type Change } from '../domain/deltas.js';
import { previous, type Period } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { isLocked } from './ledgerKeys.js';
import { ledgerPeriodSummary, type PeriodSummary } from './periodSummary.js';
import { effectiveTimezone } from './recordExpense.js';

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

// The shown period against the one before it, both in the ledger's currency.
export interface PeriodComparison {
  // The dates compared against: the previous period, or, while the shown period is running, its
  // first days, as many as have passed of the shown one.
  readonly window: Period;
  // True when the window is the whole previous period.
  readonly whole: boolean;
  // The shown period's converted lines in its order, each with its change (periodDeltas).
  readonly lines: readonly CategoryDelta[];
  readonly total: Change;
}

export interface PeriodChart {
  // Oldest first, ending at the shown period.
  readonly trend: readonly TrendPoint[];
  // Absent when the shown period has nothing in or converted into the ledger's currency.
  readonly comparison?: PeriodComparison;
}

type Deps = Parameters<typeof ledgerPeriodSummary>[0];

interface Input {
  readonly user: User;
  readonly ledgerId: LedgerId;
  readonly period: Period;
  readonly now: Date;
}

// The converted totals of `period` and the periods before it, oldest first, each read through
// the same ledgerPeriodSummary the text screen pages with, so a bar equals the total shown after
// paging to its period. Undefined when any of them can't be read: the user is no longer a
// member, or the ledger is sealed and locked.
export function periodTrend(deps: Deps, input: Input): readonly TrendPoint[] | undefined {
  return trendSummaries(deps, input)?.map(trendPoint);
}

// The trend, and the shown period compared with the one before it. A past period is compared
// whole with the previous one, already read for the trend. A running one (the ledger's today
// inside it) is compared with the previous period's first n days, n the days elapsed of the
// shown one counting today, clipped at the previous period's end: one more read, of a Period with
// the previous one's kind and a shorter `to`, through the same ledgerPeriodSummary. Undefined
// when any read fails, as for periodTrend.
export function periodChart(deps: Deps, input: Input): PeriodChart | undefined {
  const summaries = trendSummaries(deps, input);
  const shown = summaries?.at(-1);
  if (summaries === undefined || shown === undefined) return undefined;
  const trend = summaries.map(trendPoint);
  const current = convertedLines(shown);
  if (current === undefined) return { trend };
  const before = previous(input.period);
  const today = localDateOf(input.now, effectiveTimezone(deps, input.user, shown.ledger));
  const running = input.period.from <= today && today <= input.period.to;
  const end = running ? addDays(before.from, daysBetween(input.period.from, today)) : before.to;
  const window: Period = { ...before, to: end < before.to ? end : before.to };
  const whole = window.to === before.to;
  let windowSummary = whole ? summaries.at(-2) : undefined;
  if (!whole) {
    const read = ledgerPeriodSummary(deps, { ...input, period: window });
    if (read === undefined || isLocked(read)) return undefined;
    windowSummary = read;
  }
  const then = windowSummary === undefined ? undefined : convertedLines(windowSummary);
  return {
    trend,
    comparison: {
      window,
      whole,
      lines: periodDeltas(current.lines, then?.lines ?? []),
      total: changeOf(then?.totalMinor ?? 0, current.totalMinor),
    },
  };
}

function trendSummaries(deps: Deps, input: Input): PeriodSummary[] | undefined {
  const periods = [input.period];
  while (periods.length < TREND_PERIODS) periods.unshift(previous(periods[0] ?? input.period));
  const summaries: PeriodSummary[] = [];
  for (const period of periods) {
    const summary = ledgerPeriodSummary(deps, { ...input, period });
    if (summary === undefined || isLocked(summary)) return undefined;
    summaries.push(summary);
  }
  return summaries;
}

function trendPoint(summary: PeriodSummary): TrendPoint {
  return {
    period: summary.period,
    totalMinor: convertedLines(summary)?.totalMinor ?? 0,
    approximate: summary.convertedFrom.length > 0,
  };
}

// The block in the ledger's currency, when the summary's first block is in it.
function convertedLines(
  summary: PeriodSummary,
): { readonly totalMinor: number; readonly lines: readonly CategoryLine[] } | undefined {
  const [first] = summary.currencies;
  return first?.currency === summary.ledger.defaultCurrency ? first : undefined;
}

// Whole days from `from` to `to`; both are local dates, stepped in UTC with no DST.
function daysBetween(from: LocalDate, to: LocalDate): number {
  const utc = (date: LocalDate) => {
    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}
