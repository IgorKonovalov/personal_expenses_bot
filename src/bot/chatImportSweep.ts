import type { UserId } from '../db/users.js';
import type { Provider } from '../scheduler/types.js';
import {
  expiredChatImports,
  sweepChatImport,
  type ChatImportDeps,
} from '../services/importChat.js';

// The scheduler's provider for group history imports (ADR-0047): a row past its expiry goes,
// with the exported messages it holds. Nothing is sent. A tap that renewed the row between `due`
// and `fire` keeps it.

export function chatImportSweep(deps: Pick<ChatImportDeps, 'db' | 'logger'>): Provider<UserId> {
  return {
    name: 'chatImportSweep',
    due: (now) => expiredChatImports(deps, now),
    fire: (userId, now) => {
      sweepChatImport(deps, userId, now);
      return Promise.resolve();
    },
  };
}
