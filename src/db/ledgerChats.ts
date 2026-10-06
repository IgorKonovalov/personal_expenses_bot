import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';
import type { UserId } from './users.js';

// The group chats bound to shared ledgers (ADR-0014). A chat id is an external identity kept as
// text, never a ledger key.

export type ChatProvider = 'telegram';

export interface LedgerChat {
  readonly provider: ChatProvider;
  readonly chatId: string;
  readonly ledgerId: LedgerId;
  readonly active: boolean;
  readonly boundBy: UserId;
  readonly boundAt: Date;
}

interface LedgerChatRow {
  provider: ChatProvider;
  chat_id: string;
  ledger_id: string;
  active: number;
  bound_by: string;
  bound_at: string;
}

export function insertLedgerChat(db: Db, chat: LedgerChat): void {
  db.prepare<[string, string, string, number, string, string]>(
    `INSERT INTO ledger_chats (provider, chat_id, ledger_id, active, bound_by, bound_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    chat.provider,
    chat.chatId,
    chat.ledgerId,
    chat.active ? 1 : 0,
    chat.boundBy,
    chat.boundAt.toISOString(),
  );
}

// The chat's binding, active or not.
export function findLedgerChat(
  db: Db,
  provider: ChatProvider,
  chatId: string,
): LedgerChat | undefined {
  const row = db
    .prepare<[string, string], LedgerChatRow>(
      `SELECT provider, chat_id, ledger_id, active, bound_by, bound_at
         FROM ledger_chats WHERE provider = ? AND chat_id = ?`,
    )
    .get(provider, chatId);
  return row === undefined ? undefined : toLedgerChat(row);
}

// The chat a ledger is actively bound to, if any.
export function findActiveChatOfLedger(db: Db, ledgerId: LedgerId): string | undefined {
  return db
    .prepare<[string], string>(
      'SELECT chat_id FROM ledger_chats WHERE ledger_id = ? AND active = 1',
    )
    .pluck()
    .get(ledgerId);
}

// Turns the binding on or off; the ledger and its expenses are untouched. Returns false when it
// was already in that state.
export function setLedgerChatActive(
  db: Db,
  provider: ChatProvider,
  chatId: string,
  active: boolean,
): boolean {
  return (
    db
      .prepare<[number, string, string, number]>(
        'UPDATE ledger_chats SET active = ? WHERE provider = ? AND chat_id = ? AND active <> ?',
      )
      .run(active ? 1 : 0, provider, chatId, active ? 1 : 0).changes > 0
  );
}

// Moves a binding to the chat's new id (a group upgraded to a supergroup). Returns false when
// there is no binding at `from`, or one already exists at `to`.
export function moveLedgerChat(db: Db, provider: ChatProvider, from: string, to: string): boolean {
  return (
    db
      .prepare<[string, string, string, string, string]>(
        `UPDATE ledger_chats SET chat_id = ?
          WHERE provider = ? AND chat_id = ?
            AND NOT EXISTS (SELECT 1 FROM ledger_chats WHERE provider = ? AND chat_id = ?)`,
      )
      .run(to, provider, from, provider, to).changes > 0
  );
}

function toLedgerChat(row: LedgerChatRow): LedgerChat {
  return {
    provider: row.provider,
    chatId: row.chat_id,
    ledgerId: row.ledger_id as LedgerId,
    active: row.active === 1,
    boundBy: row.bound_by as UserId,
    boundAt: new Date(row.bound_at),
  };
}
