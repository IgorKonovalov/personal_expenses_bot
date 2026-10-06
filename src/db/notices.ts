import type { Db } from './connection.js';
import type { UserId } from './users.js';

// The one-time explanations (ADR-0037): the full help on stray input, the hint that editing a
// message doesn't edit its expense, and the two sealed-ledger plaintext warnings.
export const NOTICES = [
  'stray_help',
  'edit_hint',
  'export_plaintext',
  'reminder_plaintext',
] as const;

export type NoticeKey = (typeof NOTICES)[number];

// Marks the notice seen. True when this call inserted the row: the first time, decided by the
// insert alone, so two concurrent first occurrences get one true.
export function insertNoticeSeen(db: Db, userId: UserId, notice: NoticeKey, at: Date): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        'INSERT OR IGNORE INTO user_notices (user_id, notice, seen_at) VALUES (?, ?, ?)',
      )
      .run(userId, notice, at.toISOString()).changes === 1
  );
}

export function deleteUserNotices(db: Db, userId: UserId): void {
  db.prepare<[string]>('DELETE FROM user_notices WHERE user_id = ?').run(userId);
}
