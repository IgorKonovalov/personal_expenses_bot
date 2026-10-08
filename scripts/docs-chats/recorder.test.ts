import { InputFile } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  SECOND_ALLOWED_ID,
  createTestBot,
  textUpdate,
  withMessageIds,
  type ApiCall,
} from '../../src/bot/testHarness.js';
import { createRecorder } from './recorder.js';
import { expectReply, runScenario, say, scenario, tap } from './scenario.js';

const CHAT = 7;
const send = (text: string, reply_markup?: unknown): ApiCall => ({
  method: 'sendMessage',
  payload: { chat_id: CHAT, text, ...(reply_markup === undefined ? {} : { reply_markup }) },
});
const inline = (...labels: string[]) => ({
  inline_keyboard: [labels.map((text) => ({ text, callback_data: `cb:${text}` }))],
});

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

  it('replaces an edited bubble in place, by the message id withMessageIds handed out', () => {
    const recorder = createRecorder(CHAT);
    recorder.apply([send('<b>first</b>', inline('A')), send('second')]);
    recorder.apply([
      {
        method: 'editMessageText',
        payload: { chat_id: CHAT, message_id: 101, text: 'first, edited' },
      },
      {
        method: 'editMessageReplyMarkup',
        payload: { chat_id: CHAT, message_id: 102, reply_markup: inline('B', 'C') },
      },
    ]);
    expect(recorder.transcript('t').bubbles).toEqual([
      { from: 'bot', html: 'first, edited' },
      {
        from: 'bot',
        html: 'second',
        buttons: [
          [
            { text: 'B', kind: 'callback' },
            { text: 'C', kind: 'callback' },
          ],
        ],
      },
    ]);
  });

  it('removes a deleted bubble, a user message included', () => {
    const recorder = createRecorder(CHAT);
    recorder.user('450 кофе', 1);
    recorder.apply([send('one'), send('two')]);
    recorder.apply([
      { method: 'deleteMessage', payload: { chat_id: CHAT, message_id: 101 } },
      { method: 'deleteMessage', payload: { chat_id: CHAT, message_id: 1 } },
    ]);
    expect(recorder.transcript('t').bubbles).toEqual([{ from: 'bot', html: 'two' }]);
  });

  it('puts a callback answer with text after the tapped bubble, and drops one without', () => {
    const recorder = createRecorder(CHAT);
    recorder.apply([send('card', inline('A')), send('later')]);
    const changed = recorder.apply(
      [
        { method: 'answerCallbackQuery', payload: { callback_query_id: 'q1' } },
        { method: 'answerCallbackQuery', payload: { callback_query_id: 'q2', text: 'Готово' } },
      ],
      101,
    );
    expect(changed).toBe(1);
    expect(recorder.transcript('t').bubbles).toEqual([
      { from: 'bot', html: 'card', buttons: [[{ text: 'A', kind: 'callback' }]] },
      { from: 'toast', text: 'Готово' },
      { from: 'bot', html: 'later' },
    ]);
  });

  it('draws a sent document or photo as a file bubble with its name only', () => {
    const recorder = createRecorder(CHAT);
    recorder.apply([
      {
        method: 'sendDocument',
        payload: { chat_id: CHAT, document: new InputFile(new Uint8Array([1, 2]), 'expenses.csv') },
      },
      {
        method: 'sendPhoto',
        payload: { chat_id: CHAT, photo: new InputFile(new Uint8Array([3]), 'chart.png') },
      },
    ]);
    expect(recorder.transcript('t').bubbles).toEqual([
      { from: 'bot-file', fileName: 'expenses.csv' },
      { from: 'bot-file', fileName: 'chart.png' },
    ]);
  });

  it('keeps the latest reply keyboard as the chat bottom keyboard', () => {
    const recorder = createRecorder(CHAT);
    recorder.apply([
      send('hello', { keyboard: [[{ text: 'Сегодня' }, { text: 'Неделя' }]] }),
      send('again', { keyboard: [[{ text: 'Месяц' }], ['Помощь']] }),
    ]);
    const transcript = recorder.transcript('t');
    expect(transcript.replyKeyboard).toEqual([['Месяц'], ['Помощь']]);
    expect(transcript.bubbles).toEqual([
      { from: 'bot', html: 'hello' },
      { from: 'bot', html: 'again' },
    ]);
  });

  it('keeps a web_app button with its URL fragment', () => {
    const recorder = createRecorder(CHAT);
    recorder.apply([
      send('month', {
        inline_keyboard: [
          [{ text: 'График', web_app: { url: 'https://example.test/app/#z=abc&v=1' } }],
          [{ text: 'Сайт', url: 'https://example.test/' }],
        ],
      }),
    ]);
    expect(recorder.transcript('t').bubbles).toEqual([
      {
        from: 'bot',
        html: 'month',
        buttons: [
          [{ text: 'График', kind: 'web_app', fragment: '#z=abc&v=1' }],
          [{ text: 'Сайт', kind: 'url' }],
        ],
      },
    ]);
  });

  it('drops the methods the chat does not show, and calls to other chats', () => {
    const recorder = createRecorder(CHAT);
    const changed = recorder.apply([
      { method: 'setMyCommands', payload: { commands: [] } },
      { method: 'setChatMenuButton', payload: { chat_id: CHAT } },
      { method: 'setMessageReaction', payload: { chat_id: CHAT, message_id: 1, reaction: [] } },
      { method: 'sendMessage', payload: { chat_id: CHAT + 1, text: 'to the admin' } },
    ]);
    expect(changed).toBe(0);
    expect(recorder.transcript('t').bubbles).toEqual([]);
  });
});

describe('the scenario runner (ADR-0048)', () => {
  const now = '2026-09-15T10:30:00Z';

  it('throws on a tap no button in the latest bot message carries, naming it and the scenario', async () => {
    const broken = scenario('broken-tap', { chat: 'private', now }, [
      say('450 кофе'),
      tap('Нет такой'),
    ]);
    await expect(runScenario(broken)).rejects.toThrow(
      'scenario broken-tap: no button «Нет такой» in the latest bot message',
    );
  });

  it('throws on a step after which the bot sends nothing to the chat', () => {
    const silent: ApiCall[] = [
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'q' } },
      { method: 'sendMessage', payload: { chat_id: CHAT + 1, text: 'elsewhere' } },
    ];
    expect(() => {
      expectReply('quiet', say('450 кофе'), CHAT, silent);
    }).toThrow('scenario quiet: the bot sent nothing after say «450 кофе»');
    expect(() => {
      expectReply('quiet', tap('Категория'), CHAT, []);
    }).toThrow('scenario quiet: the bot sent nothing after tap «Категория»');
    expect(() => {
      expectReply('ok', say('450 кофе'), CHAT, [send('card')]);
    }).not.toThrow();
  });
});
