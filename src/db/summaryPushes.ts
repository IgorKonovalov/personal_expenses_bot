import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';

// The summary pushes that happened (ADR-0031): the row is the claim, inserted before the send.

// `period`: the monthly push, for a calendar month or a budget period; `week`: the weekly one.
export type SummaryKind = 'period' | 'week';
export type SummaryOutcome = 'sent' | 'empty';

// Inserts the claim unless that (ledger, kind, period key) has one. False when it had: another
// tick claimed it first, and nothing is to be sent.
export function claimSummaryPush(
  db: Db,
  push: {
    readonly ledgerId: LedgerId;
    readonly kind: SummaryKind;
    readonly periodKey: string;
    readonly outcome: SummaryOutcome;
    readonly createdAt: Date;
  },
): boolean {
  return (
    db
      .prepare<[string, string, string, string, string]>(
        `INSERT INTO summary_pushes (ledger_id, kind, period_key, outcome, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(push.ledgerId, push.kind, push.periodKey, push.outcome, push.createdAt.toISOString())
      .changes > 0
  );
}

// The claim's outcome; undefined when that push never happened.
export function findSummaryPush(
  db: Db,
  ledgerId: LedgerId,
  kind: SummaryKind,
  periodKey: string,
): SummaryOutcome | undefined {
  return db
    .prepare<[string, string, string], SummaryOutcome>(
      'SELECT outcome FROM summary_pushes WHERE ledger_id = ? AND kind = ? AND period_key = ?',
    )
    .pluck()
    .get(ledgerId, kind, periodKey);
}

export interface PushKey {
  readonly ledgerId: LedgerId;
  readonly kind: SummaryKind;
  readonly periodKey: string;
}

// Which of `keys` are claimed, as `claimKey` strings. One statement whatever the number of keys,
// each looked up by the primary key: a scheduler tick checks every recipient's candidates at once.
export function listClaimedPushes(db: Db, keys: readonly PushKey[]): Set<string> {
  const rows = db
    .prepare<[string], { ledger_id: string; kind: SummaryKind; period_key: string }>(
      `SELECT s.ledger_id, s.kind, s.period_key
         FROM json_each(?) j
         JOIN summary_pushes s
           ON s.ledger_id = json_extract(j.value, '$[0]')
          AND s.kind = json_extract(j.value, '$[1]')
          AND s.period_key = json_extract(j.value, '$[2]')`,
    )
    .all(JSON.stringify(keys.map((key) => [key.ledgerId, key.kind, key.periodKey])));
  return new Set(rows.map((row) => claimKey(row.ledger_id as LedgerId, row.kind, row.period_key)));
}

export function claimKey(ledgerId: LedgerId, kind: SummaryKind, periodKey: string): string {
  return `${ledgerId} ${kind} ${periodKey}`;
}

// Account deletion: the ledger's rows go with it. Returns how many went.
export function deleteLedgerSummaryPushes(db: Db, ledgerId: LedgerId): number {
  return db.prepare<[string]>('DELETE FROM summary_pushes WHERE ledger_id = ?').run(ledgerId)
    .changes;
}
