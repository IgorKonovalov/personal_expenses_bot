import { Api, Composer, Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../logger.js';
import { logContent, textUpdate } from '../testHarness.js';
import { slowUpdate } from './slowUpdate.js';

const me = { id: 42, is_bot: true, first_name: 'Test Bot', username: 'test_bot' } as UserFromGetMe;

// Runs one `450 coffee` update through slowUpdate and a handler that advances the injected
// clock by `handlerMs`. Returns the log lines.
async function runUpdate(handlerMs: number): Promise<string[]> {
  const logLines: string[] = [];
  const logger = createLogger('info', { write: (line: string) => void logLines.push(line) });
  let clock = 5_000;
  const chain = new Composer<Context>();
  chain.use(slowUpdate({ logger, clockMs: () => clock }));
  chain.use(() => {
    clock += handlerMs;
  });
  const ctx = new Context(
    textUpdate({ updateId: 7, text: '450 coffee', messageId: 31 }),
    new Api('123456:test-token'),
    me,
  );
  await chain.middleware()(ctx, () => Promise.resolve());
  return logLines.map(logContent);
}

describe('slowUpdate', () => {
  it('logs one slow update with the update type and duration only, for a 1,200 ms handler', async () => {
    expect(await runUpdate(1_200)).toEqual([
      JSON.stringify({ level: 40, updateType: 'message', ms: 1200, msg: 'slow update' }),
    ]);
  });

  it('logs nothing for a 999 ms handler', async () => {
    expect(await runUpdate(999)).toEqual([]);
  });
});
