import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';
import type { UserId } from './users.js';

// A group history import in progress (ADR-0047), one row per user. The payload is the service's
// JSON, opaque here.

export interface ChatImportRow {
  readonly userId: UserId;
  readonly ledgerId: LedgerId;
  readonly chatId: string;
  readonly nonce: string;
  readonly payload: string;
  readonly noticeMessageId: number | null;
  readonly expiresAt: Date;
}

interface Row {
  user_id: string;
  ledger_id: string;
  chat_id: string;
  nonce: string;
  payload: string;
  notice_message_id: number | null;
  expires_at: string;
}

function toChatImport(row: Row): ChatImportRow {
  return {
    userId: row.user_id as UserId,
    ledgerId: row.ledger_id as LedgerId,
    chatId: row.chat_id,
    nonce: row.nonce,
    payload: row.payload,
    noticeMessageId: row.notice_message_id,
    expiresAt: new Date(row.expires_at),
  };
}

// Writes the user's row whole, replacing any earlier one.
export function saveChatImport(db: Db, row: ChatImportRow): void {
  db.prepare<[string, string, string, string, string, number | null, string]>(
    `INSERT INTO chat_imports
       (user_id, ledger_id, chat_id, nonce, payload, notice_message_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       ledger_id = excluded.ledger_id, chat_id = excluded.chat_id, nonce = excluded.nonce,
       payload = excluded.payload, notice_message_id = excluded.notice_message_id,
       expires_at = excluded.expires_at`,
  ).run(
    row.userId,
    row.ledgerId,
    row.chatId,
    row.nonce,
    row.payload,
    row.noticeMessageId,
    row.expiresAt.toISOString(),
  );
}

export function findChatImport(db: Db, userId: UserId): ChatImportRow | undefined {
  const row = db.prepare<[string], Row>('SELECT * FROM chat_imports WHERE user_id = ?').get(userId);
  return row === undefined ? undefined : toChatImport(row);
}

// Rewrites the payload and the expiry of the row holding `nonce`. False when the row is gone or
// holds another nonce.
export function updateChatImport(
  db: Db,
  userId: UserId,
  nonce: string,
  update: { readonly payload: string; readonly expiresAt: Date },
): boolean {
  return (
    db
      .prepare<[string, string, string, string]>(
        'UPDATE chat_imports SET payload = ?, expires_at = ? WHERE user_id = ? AND nonce = ?',
      )
      .run(update.payload, update.expiresAt.toISOString(), userId, nonce).changes === 1
  );
}

// True when this call deleted the user's row.
export function deleteChatImport(db: Db, userId: UserId): boolean {
  return (
    db.prepare<[string]>('DELETE FROM chat_imports WHERE user_id = ?').run(userId).changes === 1
  );
}

// The users whose rows expired by `now`, oldest expiry first.
export function listExpiredChatImports(db: Db, now: Date): UserId[] {
  return db
    .prepare<[string], string>(
      'SELECT user_id FROM chat_imports WHERE expires_at <= ? ORDER BY expires_at, user_id',
    )
    .pluck()
    .all(now.toISOString()) as UserId[];
}

// Deletes the user's row only while it is expired by `now`: a tap that renewed it in between
// keeps it. True when this call deleted it.
export function deleteExpiredChatImport(db: Db, userId: UserId, now: Date): boolean {
  return (
    db
      .prepare<[string, string]>('DELETE FROM chat_imports WHERE user_id = ? AND expires_at <= ?')
      .run(userId, now.toISOString()).changes === 1
  );
}

// Adds an imported message's sender as a `member` of the ledger. The export's name becomes the
// display name only when the membership has none: a name the group already showed stays.
export function joinImportedMember(
  db: Db,
  member: {
    readonly ledgerId: LedgerId;
    readonly userId: UserId;
    readonly displayName: string | null;
    readonly joinedAt: Date;
  },
): void {
  db.prepare<[string, string, string | null, string]>(
    `INSERT INTO ledger_members (ledger_id, user_id, role, display_name, joined_at)
     VALUES (?, ?, 'member', ?, ?)
     ON CONFLICT (ledger_id, user_id) DO UPDATE SET
       display_name = COALESCE(ledger_members.display_name, excluded.display_name)`,
  ).run(member.ledgerId, member.userId, member.displayName, member.joinedAt.toISOString());
}
