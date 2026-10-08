import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { register } from '../scheduler/types.js';
import { runTick } from '../scheduler/worker.js';
import { groupAskProvider } from './groupAskProvider.js';
import {
  ALLOWED_ID,
  GROUP_ID,
  createTestBot,
  groupTextUpdate,
  myChatMemberUpdate,
  withMessageIds,
} from './testHarness.js';

// The question to `Осталось 2` is asked at 10:00:00 and expires at 10:15:00.
const ASKED = new Date('2026-10-07T10:00:00Z');

async function asked() {
  const test = createTestBot({ now: ASKED });
  await test.bot.handleUpdate(
    myChatMemberUpdate({ updateId: 1, fromId: ALLOWED_ID, oldStatus: 'left', newStatus: 'member' }),
  );
  withMessageIds(test.bot, 700);
  await test.bot.handleUpdate(
    groupTextUpdate({ updateId: 2, text: 'Осталось 2', messageId: 11, date: ASKED }),
  );
  const deleteMessage = vi.fn<(chatId: number | string, messageId: number) => Promise<true>>(() =>
    Promise.resolve(true),
  );
  const provider = groupAskProvider(
    { db: test.db, logger: createLogger('silent') },
    { deleteMessage },
  );
  const rows = () => test.db.prepare('SELECT message_id FROM group_asks').pluck().all();
  return { ...test, provider, deleteMessage, rows };
}

describe('groupAskProvider', () => {
  it('asks about Осталось 2 and records nothing', async () => {
    const { rows, db } = await asked();

    expect(rows()).toEqual([11]);
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(0);
  });

  it('is due at 10:15:00 and not at 10:14:59', async () => {
    const { provider } = await asked();

    expect(provider.due(new Date('2026-10-07T10:14:59Z'))).toEqual([]);
    expect(provider.due(new Date('2026-10-07T10:15:00Z'))).toMatchObject([
      { chatId: String(GROUP_ID), messageId: 11, askMessageId: 701 },
    ]);
  });

  it('deletes the question and the row once, however often it fires', async () => {
    const { provider, deleteMessage, rows, db } = await asked();
    const [due] = provider.due(new Date('2026-10-07T10:15:00Z'));
    if (due === undefined) throw new Error('setup: nothing due');

    await provider.fire(due, new Date('2026-10-07T10:15:00Z'));
    await provider.fire(due, new Date('2026-10-07T10:16:00Z'));

    expect(deleteMessage.mock.calls).toEqual([[GROUP_ID, 701]]);
    expect(rows()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(0);
  });

  it('drops a delete Telegram refuses, and the next tick finds nothing', async () => {
    const { provider, deleteMessage, rows } = await asked();
    deleteMessage.mockRejectedValueOnce(
      new GrammyError(
        'refused',
        { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
        'deleteMessage',
        {},
      ),
    );
    const logLines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void logLines.push(line) });
    const providers = [register(provider)];

    await runTick({ logger, providers }, new Date('2026-10-07T10:15:00Z'));
    await runTick({ logger, providers }, new Date('2026-10-07T10:16:00Z'));

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
    expect(logLines.filter((line) => line.includes('scheduled occurrence failed'))).toEqual([]);
  });
});
