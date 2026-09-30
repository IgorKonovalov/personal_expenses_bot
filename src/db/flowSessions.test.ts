import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import {
  clearPendingFlow,
  completePendingFlow,
  findFlowSession,
  savePendingFlow,
  saveScreenAnchor,
} from './flowSessions.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const EXPIRES = new Date('2026-09-30T10:10:00Z');
const USER = 'user-a' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
});

const anchor = { chatId: 1001, messageId: 7, screen: 'categories', screenCtx: '{"ledgerId":"l"}' };
const flow = { kind: 'categoryAdd', payload: '{"ledgerId":"l"}', expiresAt: EXPIRES };

describe('flow sessions repository', () => {
  it('has no row for a user who never opened a screen', () => {
    expect(findFlowSession(db, USER)).toBeUndefined();
  });

  it('keeps one row per user: a new anchor replaces the old and keeps the pending flow', () => {
    saveScreenAnchor(db, USER, anchor);
    savePendingFlow(db, USER, flow);
    saveScreenAnchor(db, USER, { ...anchor, messageId: 8 });

    expect(db.prepare('SELECT COUNT(*) FROM flow_sessions').pluck().get()).toBe(1);
    expect(findFlowSession(db, USER)).toEqual({
      anchor: { ...anchor, messageId: 8 },
      pending: flow,
      lastInputKey: null,
    });
  });

  it('clears a pending flow once and keeps the anchor', () => {
    saveScreenAnchor(db, USER, anchor);
    savePendingFlow(db, USER, flow);

    expect(clearPendingFlow(db, USER)).toBe(true);
    expect(clearPendingFlow(db, USER)).toBe(false);
    expect(findFlowSession(db, USER)).toEqual({ anchor, pending: null, lastInputKey: null });
  });

  it('records the answer that completed the flow', () => {
    saveScreenAnchor(db, USER, anchor);
    savePendingFlow(db, USER, flow);

    expect(completePendingFlow(db, USER, 'tg:1001:9')).toBe(true);
    expect(completePendingFlow(db, USER, 'tg:1001:10')).toBe(false);
    expect(findFlowSession(db, USER)).toEqual({
      anchor,
      pending: null,
      lastInputKey: 'tg:1001:9',
    });
  });
});
