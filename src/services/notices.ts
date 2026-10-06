import type { Db } from '../db/connection.js';
import { insertNoticeSeen, type NoticeKey } from '../db/notices.js';
import type { User } from '../db/users.js';

export type { NoticeKey } from '../db/notices.js';

// Marks a one-time notice seen (ADR-0037) and says whether it was new: true the first time, so
// the caller shows the explanation, false ever after.
export function seenNotice(
  { db }: { readonly db: Db },
  user: User,
  notice: NoticeKey,
  now: Date,
): boolean {
  return insertNoticeSeen(db, user.id, notice, now);
}
