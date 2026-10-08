import type { Api } from 'grammy';
import type { GroupAsk } from '../db/groupAsks.js';
import type { Provider } from '../scheduler/types.js';
import { dueGroupAsks, expireGroupAsk, type GroupDeps } from '../services/groupChats.js';

// The scheduler's provider for the questions to amount-last group messages (ADR-0046): one
// nobody answered within GROUP_ASK_TTL_MS goes. Firing claims the row in a transaction, then
// deletes the question message; a delete Telegram refuses (gone already, older than 48 hours)
// is logged at debug and dropped.

export function groupAskProvider(
  deps: Pick<GroupDeps, 'db' | 'logger'>,
  api: Pick<Api, 'deleteMessage'>,
): Provider<GroupAsk> {
  return {
    name: 'groupAsk',
    due: (now) => dueGroupAsks(deps, now),
    fire: async (ask) => {
      if (!expireGroupAsk(deps, ask)) return;
      try {
        await api.deleteMessage(Number(ask.chatId), ask.askMessageId);
      } catch (error) {
        deps.logger.debug(
          { err: error instanceof Error ? error.name : typeof error },
          'expired group ask not deleted',
        );
      }
    },
  };
}
