import { Api, GrammyError } from 'grammy';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { insertIdentity, insertUser, type UserId } from '../db/users.js';
import { createLogger } from '../logger.js';
import { html } from './render/html.js';
import { SEND_GAP_MS, scheduledSender } from './scheduledSender.js';

const NOW = new Date('2026-11-01T08:00:00Z');
const TELEGRAM_ID = 1001;
const USER = 'user-a' as UserId;

type Answer = 'ok' | { readonly code: 403 | 429; readonly retryAfter?: number };

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertIdentity(db, { provider: 'telegram', externalId: String(TELEGRAM_ID), userId: USER });
});

// A sender on a fake API that answers each sendMessage with the next of `answers` (then `ok`),
// on an injected clock that only a sleep moves.
function fakeSender(answers: readonly Answer[] = []) {
  const queue = [...answers];
  let clock = 1_000;
  const attempts: number[] = [];
  const sleeps: number[] = [];
  const api = new Api('123456:test-token');
  api.config.use((_prev, method) => {
    if (method !== 'sendMessage') return Promise.resolve({ ok: true, result: true as never });
    attempts.push(clock);
    const answer = queue.shift() ?? 'ok';
    if (answer === 'ok') return Promise.resolve({ ok: true, result: true as never });
    return Promise.resolve({
      ok: false,
      error_code: answer.code,
      description: answer.code === 429 ? 'Too Many Requests' : 'Forbidden: bot was blocked',
      ...(answer.retryAfter === undefined
        ? {}
        : { parameters: { retry_after: answer.retryAfter } }),
    });
  });
  const sender = scheduledSender({
    api,
    db,
    logger: createLogger('silent'),
    now: () => NOW,
    clockMs: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return { sender, attempts, sleeps };
}

const body = html`Итоги сентября`;

function unreachableAt(): unknown {
  return db.prepare('SELECT unreachable_at FROM users WHERE id = ?').pluck().get(USER);
}

describe('scheduledSender', () => {
  it('sleeps retry_after on a 429 and delivers the message once', async () => {
    const { sender, attempts, sleeps } = fakeSender([{ code: 429, retryAfter: 3 }]);

    expect(await sender.send(TELEGRAM_ID, body)).toBe('sent');

    expect(attempts).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('gives up after three 429s in a row: 1 attempt + 2 retries, then throws', async () => {
    const answer = { code: 429, retryAfter: 1 } as const;
    const { sender, attempts } = fakeSender([answer, answer, answer, answer]);

    await expect(sender.send(TELEGRAM_ID, body)).rejects.toBeInstanceOf(GrammyError);

    expect(attempts).toHaveLength(3);
  });

  it('makes one attempt on a 403 and marks the recipient unreachable', async () => {
    const { sender, attempts, sleeps } = fakeSender([{ code: 403 }]);

    expect(await sender.send(TELEGRAM_ID, body)).toBe('unreachable');

    expect(attempts).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(unreachableAt()).toBe(NOW.toISOString());
  });

  it('spaces five sends at least 40 ms apart on the injected clock', async () => {
    const { sender, attempts } = fakeSender();

    for (let i = 0; i < 5; i += 1) await sender.send(TELEGRAM_ID, body);

    expect(attempts).toHaveLength(5);
    const gaps = attempts.slice(1).map((at, i) => at - (attempts[i] ?? 0));
    expect(gaps).toEqual([40, 40, 40, 40]);
    expect(gaps.every((gap) => gap >= SEND_GAP_MS)).toBe(true);
  });

  it('paces sends started together, one after another', async () => {
    const { sender, attempts } = fakeSender();

    await Promise.all([1, 2, 3].map(() => sender.send(TELEGRAM_ID, body)));

    expect(attempts).toEqual([1_000, 1_040, 1_080]);
  });
});
