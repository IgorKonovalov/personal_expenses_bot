import { describe, expect, it } from 'vitest';
import { readTelegramExport } from './telegramExport.js';

function exportOf(fields: Record<string, unknown>, messages: unknown[]): string {
  return JSON.stringify({
    name: 'Семья',
    type: 'private_supergroup',
    id: 1234567890,
    ...fields,
    messages,
  });
}

describe('readTelegramExport', () => {
  it('reads a group export’s id, name, type and its users’ messages', () => {
    const read = readTelegramExport(
      exportOf({}, [
        {
          id: 11,
          type: 'message',
          date_unixtime: '1784586600',
          from: 'A',
          from_id: 'user1001',
          text: 'Чайник 3200',
        },
        {
          id: 12,
          type: 'message',
          date_unixtime: '1784586700',
          from: null,
          from_id: 'user1003',
          text: ['Краска ', { type: 'bold', text: '2000' }, '\nкисти 500'],
          forwarded_from: 'C',
        },
        { id: 13, type: 'service', date_unixtime: '1784586800', actor_id: 'user1001' },
        {
          id: 14,
          type: 'message',
          date_unixtime: '1784586900',
          from: 'Канал',
          from_id: 'channel77',
          text: '450 кафе',
        },
      ]),
    );

    expect(read).toEqual({
      kind: 'export',
      chatId: 1234567890,
      name: 'Семья',
      type: 'private_supergroup',
      messages: [
        {
          id: 11,
          at: new Date('2026-07-20T22:30:00Z'),
          senderTelegramId: 1001,
          senderName: 'A',
          text: 'Чайник 3200',
          forwarded: false,
        },
        {
          id: 12,
          at: new Date(1784586700 * 1000),
          senderTelegramId: 1003,
          senderName: null,
          text: 'Краска 2000\nкисти 500',
          forwarded: true,
        },
      ],
    });
  });

  it('refuses an export of a private chat, a channel or the whole account', () => {
    expect(readTelegramExport(exportOf({ type: 'personal_chat' }, []))).toEqual({
      kind: 'notExport',
    });
    expect(readTelegramExport(exportOf({ type: 'public_channel' }, []))).toEqual({
      kind: 'notExport',
    });
    expect(readTelegramExport(JSON.stringify({ about: 'x', chats: { list: [] } }))).toEqual({
      kind: 'notExport',
    });
  });

  it('refuses text that is not JSON, and JSON without messages', () => {
    expect(readTelegramExport('not json')).toEqual({ kind: 'notExport' });
    expect(readTelegramExport(JSON.stringify({ id: 1, type: 'private_group' }))).toEqual({
      kind: 'notExport',
    });
  });
});
