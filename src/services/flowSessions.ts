import type { CategoryId } from '../db/categories.js';
import type { Db } from '../db/connection.js';
import {
  clearPendingFlow,
  completePendingFlow,
  findFlowSession,
  savePendingFlow,
  saveScreenAnchor,
} from '../db/flowSessions.js';
import type { LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';

// ADR-0009's session row, typed: the user's screen anchor (ADR-0011) and at most one pending
// text flow. It lives in SQLite, so both survive a restart.

// A flow's answer is accepted for this long after its prompt.
export const FLOW_TTL_MS = 10 * 60 * 1000;
// A non-expense text this soon after a flow expired gets flowExpired instead of help.
export const EXPIRED_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CategoriesScreen {
  readonly name: 'categories';
  readonly ledgerId: LedgerId;
  // Opened from the settings hub: the screen carries a [« Назад] back to it.
  readonly fromSettings?: true;
}

// A /week or /month summary. Paging reads this ledger, not the one active at tap time.
export interface SummaryScreen {
  readonly name: 'summary';
  readonly ledgerId: LedgerId;
}

export type Screen = CategoriesScreen | SummaryScreen | { readonly name: 'settings' };

export interface ScreenAnchor {
  readonly chatId: number;
  readonly messageId: number;
  readonly screen: Screen;
}

export type CategoryFlow =
  | { readonly kind: 'categoryAdd'; readonly ledgerId: LedgerId }
  | {
      readonly kind: 'categoryRename';
      readonly ledgerId: LedgerId;
      readonly categoryId: CategoryId;
    };

export type Flow = CategoryFlow | { readonly kind: 'setTimezone' };

type Deps = { readonly db: Db };

export function currentAnchor({ db }: Deps, user: User): ScreenAnchor | undefined {
  const anchor = findFlowSession(db, user.id)?.anchor ?? null;
  if (anchor === null) return undefined;
  const screen = parseScreen(anchor.screen, anchor.screenCtx);
  return screen === undefined
    ? undefined
    : { chatId: anchor.chatId, messageId: anchor.messageId, screen };
}

export function setAnchor({ db }: Deps, user: User, anchor: ScreenAnchor): void {
  const { name, ...screenCtx } = anchor.screen;
  saveScreenAnchor(db, user.id, {
    chatId: anchor.chatId,
    messageId: anchor.messageId,
    screen: name,
    screenCtx: JSON.stringify(screenCtx),
  });
}

// Starts a flow, replacing any pending one (ADR-0009).
export function startFlow({ db }: Deps, user: User, flow: Flow, now: Date): void {
  const { kind, ...payload } = flow;
  savePendingFlow(db, user.id, {
    kind,
    payload: JSON.stringify(payload),
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
  });
}

// Returns false when nothing was pending.
export function cancelFlow({ db }: Deps, user: User): boolean {
  return clearPendingFlow(db, user.id);
}

// Marks the pending flow answered by this input. Run it in the transaction that applies the
// answer, so a redelivery either finds both or neither.
export function completeFlow({ db }: Deps, user: User, inputKey: string): void {
  if (!completePendingFlow(db, user.id, inputKey)) throw new Error('no flow to complete');
}

export type TextRoute =
  // The answer that last completed a flow, delivered again: record nothing, reply nothing.
  | { readonly kind: 'redelivered' }
  | { readonly kind: 'flow'; readonly flow: Flow }
  // Free text: an expense attempt. `expiredFlow` when a flow expired within the reply window.
  | { readonly kind: 'free'; readonly expiredFlow: boolean };

// ADR-0009's routing for a text that is neither a command nor a menu tap.
export function routeText(
  { db }: Deps,
  input: { readonly user: User; readonly inputKey: string; readonly now: Date },
): TextRoute {
  const session = findFlowSession(db, input.user.id);
  if (session === undefined) return { kind: 'free', expiredFlow: false };
  if (session.lastInputKey === input.inputKey) return { kind: 'redelivered' };
  const { pending } = session;
  if (pending === null) return { kind: 'free', expiredFlow: false };
  const now = input.now.getTime();
  const expiresAt = pending.expiresAt.getTime();
  if (now < expiresAt) {
    const flow = parseFlow(pending.kind, pending.payload);
    if (flow !== undefined) return { kind: 'flow', flow };
  }
  return { kind: 'free', expiredFlow: now < expiresAt + EXPIRED_REPLY_WINDOW_MS };
}

// A row written by a later version, or damaged, reads as no screen rather than failing.
function parseScreen(name: string, ctx: string): Screen | undefined {
  const parsed = parseObject(ctx);
  if (name === 'settings' && parsed !== undefined) return { name };
  if (name === 'summary' && typeof parsed?.ledgerId === 'string') {
    return { name, ledgerId: parsed.ledgerId as LedgerId };
  }
  if (name === 'categories' && typeof parsed?.ledgerId === 'string') {
    const ledgerId = parsed.ledgerId as LedgerId;
    return parsed.fromSettings === true
      ? { name, ledgerId, fromSettings: true }
      : { name, ledgerId };
  }
  return undefined;
}

function parseFlow(kind: string, payload: string): Flow | undefined {
  const parsed = parseObject(payload);
  if (kind === 'setTimezone' && parsed !== undefined) return { kind };
  if (typeof parsed?.ledgerId !== 'string') return undefined;
  const ledgerId = parsed.ledgerId as LedgerId;
  if (kind === 'categoryAdd') return { kind, ledgerId };
  if (kind === 'categoryRename' && typeof parsed.categoryId === 'number') {
    return { kind, ledgerId, categoryId: parsed.categoryId as CategoryId };
  }
  return undefined;
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
