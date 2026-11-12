import { describe, expect, it } from 'vitest';
import {
  DONUT_ROWS,
  WIDGET_DATA_BUDGET,
  encodeDonut,
  utf8Bytes,
  type DonutData,
  type DonutLine,
  type DonutInput,
} from './widgetData.js';

const fold = { name: 'Прочее', amount: (minor: number) => `${minor} minor` };

function input(lines: readonly DonutLine[]): DonutInput {
  return {
    title: 'Ноябрь 2026',
    total: '45 230.00 RSD',
    drill: '2026-11:ledger',
    lines,
    extra: '',
    retry: 'Не получилось загрузить. Нажмите ещё раз.',
  };
}

function decode(json: string | undefined): DonutData {
  expect(json).toBeDefined();
  return JSON.parse(json ?? '') as DonutData;
}

describe('encodeDonut', () => {
  it('keeps up to eight lines as they are', () => {
    const lines: DonutLine[] = [
      ['Продукты', 120000, '1 200.00 RSD', '7'],
      ['Кафе и рестораны', 75000, '750.00 RSD', '8'],
    ];

    expect(decode(encodeDonut(input(lines), fold))).toEqual([
      1,
      'Ноябрь 2026',
      '45 230.00 RSD',
      '2026-11:ledger',
      lines,
      '',
      'Не получилось загрузить. Нажмите ещё раз.',
    ]);
  });

  it('folds a month of 20 categories into at most 1024 bytes, the fold summing what it replaced', () => {
    // Largest first: 20 categories with 22-character Cyrillic names, 2000.00 down to 100.00.
    const lines: DonutLine[] = Array.from({ length: 20 }, (_, i) => {
      const minor = (20 - i) * 10000;
      return [
        `Категория номер ${String(i + 1).padStart(2, '0')} ддд`,
        minor,
        `${minor}`,
        `${i + 1}`,
      ];
    });

    const json = encodeDonut(input(lines), fold);
    const data = decode(json);
    const shown = data[4];

    expect(utf8Bytes(json ?? '')).toBeLessThanOrEqual(WIDGET_DATA_BUDGET);
    expect(shown.length).toBeLessThanOrEqual(DONUT_ROWS);
    const kept = shown.slice(0, -1);
    expect(kept).toEqual(lines.slice(0, kept.length));
    const replaced = lines.slice(kept.length);
    const folded = replaced.reduce((sum, line) => sum + line[1], 0);
    expect(shown.at(-1)).toEqual(['Прочее', folded, `${folded} minor`, '']);
    // Every line's minor units are still in the donut, exactly.
    expect(shown.reduce((sum, line) => sum + line[1], 0)).toBe(2100000);
  });

  it('folds more lines when eight are over the byte budget', () => {
    // Eight 60-character Cyrillic labels are 960 bytes on their own.
    const lines: DonutLine[] = Array.from({ length: 8 }, (_, i) => [
      'Ж'.repeat(60),
      (8 - i) * 100,
      `${(8 - i) * 100}`,
      `${i + 1}`,
    ]);

    const data = decode(encodeDonut(input(lines), fold));

    expect(data[4].length).toBeLessThan(8);
    expect(data[4].at(-1)?.[0]).toBe('Прочее');
    expect(data[4].reduce((sum, line) => sum + line[1], 0)).toBe(3600);
  });

  it('measures a label in UTF-8 bytes, not characters: 40 Cyrillic characters are 80 bytes', () => {
    const label = 'Ж'.repeat(40);
    expect(label.length).toBe(40);
    expect(utf8Bytes(label)).toBe(80);

    // Everything else ASCII, so the label is the only gap between characters and bytes. A budget
    // that holds the JSON counted in characters but not in bytes fits nothing: one line can't
    // fold.
    const one = { ...input([[label, 100, '1.00 RSD', '1']]), title: 'Nov', retry: 'retry' };
    const json = encodeDonut(one, fold) ?? '';
    expect(utf8Bytes(json)).toBe(json.length + 40);
    expect(encodeDonut(one, fold, json.length)).toBeUndefined();
    expect(encodeDonut(one, fold, utf8Bytes(json))).toBe(json);
  });
});
