import type { TipKey } from '../domain/tips.js';
import type { Db } from './connection.js';
import type { UserId } from './users.js';

// The contextual tips a user has been sent (ADR-0028), keyed by user and registry key.

export interface TipShown {
  // A registry key; a row may name a tip the registry has since dropped.
  readonly tip: string;
  readonly shownAt: Date;
}

// Records the tip as shown. True when this call inserted the row, so of two concurrent offers of
// the same tip only one sends it.
export function insertTipShown(db: Db, userId: UserId, tip: TipKey, at: Date): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        'INSERT OR IGNORE INTO user_tips (user_id, tip, shown_at) VALUES (?, ?, ?)',
      )
      .run(userId, tip, at.toISOString()).changes === 1
  );
}

export function listTipsShown(db: Db, userId: UserId): TipShown[] {
  return db
    .prepare<[string], { tip: string; shown_at: string }>(
      'SELECT tip, shown_at FROM user_tips WHERE user_id = ? ORDER BY shown_at, tip',
    )
    .all(userId)
    .map((row) => ({ tip: row.tip, shownAt: new Date(row.shown_at) }));
}

export function deleteUserTips(db: Db, userId: UserId): void {
  db.prepare<[string]>('DELETE FROM user_tips WHERE user_id = ?').run(userId);
}
