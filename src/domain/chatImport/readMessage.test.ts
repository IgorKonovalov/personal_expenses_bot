import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../time.js';
import { readMessage } from './readMessage.js';

const TODAY = '2026-07-21' as LocalDate;

function read(text: string) {
  return readMessage(text, 'RSD', TODAY);
}

function item(amountMinor: number, currency: 'RSD' | 'EUR', description: string) {
  return { amountMinor, currency, description, occurredOn: TODAY };
}

const LIST = 'Краска 2000\nкисти 500\nваликов на 800\n3300 дин';

describe('readMessage', () => {
  it('reads Чайник 3200 as one ready item of 320000 RSD', () => {
    expect(read('Чайник 3200')).toEqual({
      verdict: 'ready',
      items: [item(320000, 'RSD', 'Чайник')],
    });
  });

  it('reads a list whose total line matches as its three items, the total dropped', () => {
    expect(read(LIST)).toEqual({
      verdict: 'ready',
      items: [
        item(200000, 'RSD', 'Краска'),
        item(50000, 'RSD', 'кисти'),
        item(80000, 'RSD', 'валиков'),
      ],
    });
  });

  it('sends the same list to review with a total of 3400', () => {
    expect(read(LIST.replace('3300 дин', '3400 дин'))).toEqual({
      verdict: 'review',
      reason: 'total',
      items: [
        item(200000, 'RSD', 'Краска'),
        item(50000, 'RSD', 'кисти'),
        item(80000, 'RSD', 'валиков'),
      ],
      stated: { amountMinor: 340000, currency: 'RSD' },
    });
  });

  it('splits comma-separated items in two currencies', () => {
    expect(read('ремонт 300€, доставка 4500 динар')).toEqual({
      verdict: 'ready',
      items: [item(30000, 'EUR', 'ремонт'), item(450000, 'RSD', 'доставка')],
    });
  });

  it('reads Шкаф: 4500 as a ready item, not a name prefix', () => {
    expect(read('Шкаф: 4500')).toEqual({
      verdict: 'ready',
      items: [item(450000, 'RSD', 'Шкаф')],
    });
  });

  it('sends буду в 7 to review as bare', () => {
    expect(read('буду в 7')).toMatchObject({ verdict: 'review', reason: 'bare' });
  });

  it('sends Ира: ремонт 300€ to review as a prefix', () => {
    expect(read('Ира: ремонт 300€')).toMatchObject({
      verdict: 'review',
      reason: 'prefix',
      prefix: 'Ира',
      items: [item(30000, 'EUR', 'ремонт')],
    });
  });

  it('sends Лампа 1.500 to review as ambiguous', () => {
    expect(read('Лампа 1.500')).toEqual({
      verdict: 'review',
      reason: 'ambiguous',
      items: [
        {
          readings: [
            { interpretation: 'thousands', amountMinor: 150000 },
            { interpretation: 'decimal', amountMinor: 150 },
          ],
          currency: 'RSD',
          description: 'Лампа',
          occurredOn: TODAY,
        },
      ],
    });
  });

  it('reads привет всем as noAmount', () => {
    expect(read('привет всем')).toEqual({ verdict: 'noAmount' });
  });

  it('dates вчера from the message date', () => {
    expect(readMessage('Чайник 3200 вчера', 'RSD', '2026-07-21' as LocalDate)).toEqual({
      verdict: 'ready',
      items: [
        { amountMinor: 320000, currency: 'RSD', description: 'Чайник', occurredOn: '2026-07-20' },
      ],
    });
  });

  it('sends a forwarded message and a deleted sender’s message to review', () => {
    expect(readMessage('Чайник 3200', 'RSD', TODAY, { forwarded: true })).toMatchObject({
      verdict: 'review',
      reason: 'forwarded',
      items: [item(320000, 'RSD', 'Чайник')],
    });
    expect(readMessage('Чайник 3200', 'RSD', TODAY, { deletedSender: true })).toMatchObject({
      verdict: 'review',
      reason: 'deletedSender',
    });
  });

  it('sends a message with a line that does not read to review as unread', () => {
    expect(read('Краска 2000\nвстреча в 7:30')).toMatchObject({
      verdict: 'review',
      reason: 'unread',
      items: [item(200000, 'RSD', 'Краска')],
    });
  });
});
