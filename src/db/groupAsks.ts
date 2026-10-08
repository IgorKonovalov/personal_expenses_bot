import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';

// The pending questions to amount-last group messages (ADR-0046). A row is the question's only
// state: deleting it claims the answer or the expiry, so a second tap or a second fire finds
// nothing.

export interface GroupAsk {
  readonly chatId: string;
  readonly messageId: number;
  readonly ledgerId: LedgerId;
  readonly senderTelegramId: string;
  readonly text: string;
  // The message's date.
  readonly sentAt: Date;
  readonly askMessageId: number;
  readonly createdAt: Date;
}

interface GroupAskRow {
  chat_id: string;
  message_id: number;
  ledger_id: string;
  sender_telegram_id: string;
  text: string;
  sent_at: string;
  ask_message_id: number;
  created_at: string;
}

function toGroupAsk(row: GroupAskRow): GroupAsk {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    ledgerId: row.ledger_id as LedgerId,
    senderTelegramId: row.sender_telegram_id,
    text: row.text,
    sentAt: new Date(row.sent_at),
    askMessageId: row.ask_message_id,
    createdAt: new Date(row.created_at),
  };
}

// True when this call inserted the row; a message asked about before keeps its first question.
export function insertGroupAsk(db: Db, ask: GroupAsk): boolean {
  return (
    db
      .prepare<[string, number, string, string, string, string, number, string]>(
        `INSERT OR IGNORE INTO group_asks
           (chat_id, message_id, ledger_id, sender_telegram_id, text, sent_at, ask_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ask.chatId,
        ask.messageId,
        ask.ledgerId,
        ask.senderTelegramId,
        ask.text,
        ask.sentAt.toISOString(),
        ask.askMessageId,
        ask.createdAt.toISOString(),
      ).changes === 1
  );
}

export function findGroupAsk(db: Db, chatId: string, messageId: number): GroupAsk | undefined {
  const row = db
    .prepare<[string, number], GroupAskRow>(
      'SELECT * FROM group_asks WHERE chat_id = ? AND message_id = ?',
    )
    .get(chatId, messageId);
  return row === undefined ? undefined : toGroupAsk(row);
}

// True when this call deleted the row: the claim on the question's answer or expiry.
export function deleteGroupAsk(db: Db, chatId: string, messageId: number): boolean {
  return (
    db
      .prepare<[string, number]>('DELETE FROM group_asks WHERE chat_id = ? AND message_id = ?')
      .run(chatId, messageId).changes === 1
  );
}

// The questions created at or before `cutoff`, oldest first.
export function listGroupAsksCreatedBy(db: Db, cutoff: Date): GroupAsk[] {
  return db
    .prepare<[string], GroupAskRow>(
      'SELECT * FROM group_asks WHERE created_at <= ? ORDER BY created_at, chat_id, message_id',
    )
    .all(cutoff.toISOString())
    .map(toGroupAsk);
}

export function deleteSenderGroupAsks(db: Db, senderTelegramId: string): void {
  db.prepare<[string]>('DELETE FROM group_asks WHERE sender_telegram_id = ?').run(senderTelegramId);
}
