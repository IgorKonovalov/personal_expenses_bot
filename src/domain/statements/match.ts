import type { CurrencyCode } from '../currencies.js';
import type { LocalDate } from '../time.js';
import type { StatementPurchase } from './types.js';

// ADR-0032: a statement row is already recorded when a live expense of the ledger has the same
// amount and currency and an occurred_on within one day either side of the row's date.

export interface MatchCandidate {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
  readonly occurredAt: Date;
}

const MAX_DAYS_APART = 1;

// For each purchase, in statement order, the id of the expense it matches, or undefined. One to
// one: each expense absorbs at most one row. A row takes the closest-dated unmatched candidate;
// ties go to the earlier occurred_at, then the lower id.
export function matchRows(
  purchases: readonly Pick<StatementPurchase, 'date' | 'amountMinor' | 'currency'>[],
  candidates: readonly MatchCandidate[],
): (string | undefined)[] {
  const taken = new Set<string>();
  return purchases.map((purchase) => {
    let best: { candidate: MatchCandidate; days: number } | undefined;
    for (const candidate of candidates) {
      if (taken.has(candidate.id)) continue;
      if (candidate.amountMinor !== purchase.amountMinor) continue;
      if (candidate.currency !== purchase.currency) continue;
      const days = Math.abs(daysBetween(purchase.date, candidate.occurredOn));
      if (days > MAX_DAYS_APART) continue;
      if (best === undefined || before({ candidate, days }, best)) best = { candidate, days };
    }
    if (best === undefined) return undefined;
    taken.add(best.candidate.id);
    return best.candidate.id;
  });
}

function before(
  a: { candidate: MatchCandidate; days: number },
  b: { candidate: MatchCandidate; days: number },
): boolean {
  if (a.days !== b.days) return a.days < b.days;
  const at = a.candidate.occurredAt.getTime() - b.candidate.occurredAt.getTime();
  if (at !== 0) return at < 0;
  return a.candidate.id < b.candidate.id;
}

// Whole calendar days from `a` to `b`, on the date strings alone.
function daysBetween(a: LocalDate, b: LocalDate): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}
