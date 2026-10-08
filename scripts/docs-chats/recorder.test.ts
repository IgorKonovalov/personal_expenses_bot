import { describe, expect, it } from 'vitest';
import {
  SECOND_ALLOWED_ID,
  createTestBot,
  textUpdate,
  withMessageIds,
} from '../../src/bot/testHarness.js';
import { createRecorder } from './recorder.js';

describe('the docs chat recorder (ADR-0048)', () => {
  it('keeps the HTML the bot sent as the bot bubble, byte for byte', async () => {
    const now = new Date('2026-09-15T10:30:00Z');
    const { bot, calls } = createTestBot({ now });
    withMessageIds(bot);
    await bot.handleUpdate(
      textUpdate({ updateId: 1, text: '450 кофе', fromId: SECOND_ALLOWED_ID, date: now }),
    );
    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    const { text } = sent[0]?.payload as { text: string };

    const recorder = createRecorder(SECOND_ALLOWED_ID);
    recorder.user('450 кофе');
    recorder.apply(calls);
    const [user, reply] = recorder.transcript('record').bubbles;

    expect(user).toEqual({ from: 'user', text: '450 кофе' });
    expect(reply?.from).toBe('bot');
    expect(reply?.from === 'bot' ? reply.html : undefined).toBe(text);
  });
});
