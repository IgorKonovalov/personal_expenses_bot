import { describe, expect, it } from 'vitest';
import { decodeChartPayload } from '../../webapp/src/payload.js';
import { chartPayload, encodeChartPayload, type ChartInput } from './chartPayload.js';

const SEPTEMBER: ChartInput = {
  title: 'Сентябрь 2026',
  currency: 'RSD',
  totalLabel: '1 500.00 RSD',
  lines: [
    ['Еда', 120000, '1 200.00 RSD'],
    ['Транспорт', 30000, '300.00 RSD'],
  ],
  unconverted: ['Без курса НБС: 12.50 EUR'],
};

describe('encodeChartPayload', () => {
  it("round-trips through the page's decodeChartPayload to the same lines and a total of 150000", () => {
    const decoded = decodeChartPayload(`#d=${encodeChartPayload(SEPTEMBER)}`);

    expect(decoded).toEqual({
      v: 1,
      title: 'Сентябрь 2026',
      currency: 'RSD',
      totalMinor: 150000,
      totalLabel: '1 500.00 RSD',
      lines: [
        ['Еда', 120000, '1 200.00 RSD'],
        ['Транспорт', 30000, '300.00 RSD'],
      ],
      unconverted: ['Без курса НБС: 12.50 EUR'],
    });
  });

  it('writes unpadded base64url, with nothing that splits a fragment parameter', () => {
    expect(encodeChartPayload(SEPTEMBER)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a total beyond the safe integer range', () => {
    expect(() =>
      chartPayload({
        ...SEPTEMBER,
        lines: [
          ['a', Number.MAX_SAFE_INTEGER, ''],
          ['b', 1, ''],
        ],
      }),
    ).toThrow(RangeError);
  });
});
