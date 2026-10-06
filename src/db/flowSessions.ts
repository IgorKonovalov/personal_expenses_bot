import type { Db } from './connection.js';
import type { UserId } from './users.js';

// The per-user session row of ADR-0009. The JSON columns are opaque here; the flow-sessions
// service owns their shape.

export interface ScreenAnchorRow {
  readonly chatId: number;
  readonly messageId: number;
  readonly screen: string;
  readonly screenCtx: string;
}

export interface PendingFlowRow {
  readonly kind: string;
  readonly payload: string;
  readonly expiresAt: Date;
}

export interface FlowSessionRow {
  readonly anchor: ScreenAnchorRow | null;
  // Still set after expiry until something clears it.
  readonly pending: PendingFlowRow | null;
  readonly lastInputKey: string | null;
}

interface Row {
  anchor_chat_id: number | null;
  anchor_message_id: number | null;
  screen: string | null;
  screen_ctx: string | null;
  kind: string | null;
  payload: string | null;
  expires_at: string | null;
  last_input_key: string | null;
}

export function findFlowSession(db: Db, userId: UserId): FlowSessionRow | undefined {
  const row = db
    .prepare<[string], Row>(
      `SELECT anchor_chat_id, anchor_message_id, screen, screen_ctx, kind, payload, expires_at,
              last_input_key
         FROM flow_sessions WHERE user_id = ?`,
    )
    .get(userId);
  if (row === undefined) return undefined;
  return {
    anchor:
      row.anchor_chat_id === null ||
      row.anchor_message_id === null ||
      row.screen === null ||
      row.screen_ctx === null
        ? null
        : {
            chatId: row.anchor_chat_id,
            messageId: row.anchor_message_id,
            screen: row.screen,
            screenCtx: row.screen_ctx,
          },
    pending:
      row.kind === null || row.payload === null || row.expires_at === null
        ? null
        : { kind: row.kind, payload: row.payload, expiresAt: new Date(row.expires_at) },
    lastInputKey: row.last_input_key,
  };
}

// Makes a message the user's one screen anchor, replacing any earlier one.
export function saveScreenAnchor(db: Db, userId: UserId, anchor: ScreenAnchorRow): void {
  db.prepare<[string, number, number, string, string]>(
    `INSERT INTO flow_sessions (user_id, anchor_chat_id, anchor_message_id, screen, screen_ctx)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       anchor_chat_id = excluded.anchor_chat_id, anchor_message_id = excluded.anchor_message_id,
       screen = excluded.screen, screen_ctx = excluded.screen_ctx`,
  ).run(userId, anchor.chatId, anchor.messageId, anchor.screen, anchor.screenCtx);
}

// Starts a flow, replacing any pending one.
export function savePendingFlow(db: Db, userId: UserId, flow: PendingFlowRow): void {
  db.prepare<[string, string, string, string]>(
    `INSERT INTO flow_sessions (user_id, kind, payload, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       kind = excluded.kind, payload = excluded.payload, expires_at = excluded.expires_at`,
  ).run(userId, flow.kind, flow.payload, flow.expiresAt.toISOString());
}

// Clears the pending flow, expired or not. Returns false when none was pending.
export function clearPendingFlow(db: Db, userId: UserId): boolean {
  const { changes } = db
    .prepare<[string]>(
      `UPDATE flow_sessions SET kind = NULL, payload = NULL, expires_at = NULL
        WHERE user_id = ? AND kind IS NOT NULL`,
    )
    .run(userId);
  return changes === 1;
}

// Deletes the user's session row: anchor, pending flow and last input key.
export function deleteFlowSession(db: Db, userId: UserId): boolean {
  return (
    db.prepare<[string]>('DELETE FROM flow_sessions WHERE user_id = ?').run(userId).changes > 0
  );
}

// Clears the pending flow and records the answer that completed it, so its redelivery is
// recognised. Returns false when no flow was pending.
export function completePendingFlow(db: Db, userId: UserId, inputKey: string): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      `UPDATE flow_sessions
          SET kind = NULL, payload = NULL, expires_at = NULL, last_input_key = ?
        WHERE user_id = ? AND kind IS NOT NULL`,
    )
    .run(inputKey, userId);
  return changes === 1;
}
