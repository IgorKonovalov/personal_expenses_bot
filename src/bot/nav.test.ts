import { describe, expect, it } from 'vitest';
import { pageOf, pagerRow, pickerKeyboard } from './nav.js';

const thirty = Array.from({ length: 30 }, (_, i) => i + 1);
const dataFor = (page: number) => `x:p:${page}`;

function labelsAndData(row: readonly { text: string; callback_data?: string }[]) {
  return row.map((button) => [button.text, button.callback_data]);
}

describe('pageOf', () => {
  it('pages 30 items as 8, 8, 8 and 6', () => {
    expect([1, 2, 3, 4].map((page) => pageOf(thirty, page).items.length)).toEqual([8, 8, 8, 6]);
    expect(pageOf(thirty, 4)).toEqual({ items: [25, 26, 27, 28, 29, 30], page: 4, pageCount: 4 });
  });

  it('shows the last page for a page past the end, and the first for one before it', () => {
    expect(pageOf(thirty, 9)).toMatchObject({ page: 4, items: [25, 26, 27, 28, 29, 30] });
    expect(pageOf(thirty, 0)).toMatchObject({ page: 1, items: [1, 2, 3, 4, 5, 6, 7, 8] });
  });

  it('is one page for an empty list', () => {
    expect(pageOf([], 1)).toEqual({ items: [], page: 1, pageCount: 1 });
  });
});

describe('pagerRow', () => {
  it('has no [◀] on page 1 and no [▶] on the last page', () => {
    expect(labelsAndData(pagerRow(pageOf(thirty, 1), dataFor))).toEqual([
      ['1/4', 'x:p:1'],
      ['▶', 'x:p:2'],
    ]);
    expect(labelsAndData(pagerRow(pageOf(thirty, 4), dataFor))).toEqual([
      ['◀', 'x:p:3'],
      ['4/4', 'x:p:4'],
    ]);
  });

  it('re-renders the same page from [n/N]', () => {
    expect(labelsAndData(pagerRow(pageOf(thirty, 2), dataFor))).toEqual([
      ['◀', 'x:p:1'],
      ['2/4', 'x:p:2'],
      ['▶', 'x:p:3'],
    ]);
  });

  it('is empty when everything fits on one page', () => {
    expect(pagerRow(pageOf(thirty.slice(0, 8), 1), dataFor)).toEqual([]);
  });
});

describe('pickerKeyboard', () => {
  it('puts choices two per row, then the pager, then [« Назад] alone', () => {
    const choices = ['a', 'b', 'c'].map((text) => ({ text, callback_data: `c:${text}` }));
    const pager = pagerRow(pageOf(thirty, 1), dataFor);

    expect(pickerKeyboard(choices, pager, 'back').inline_keyboard).toEqual([
      [choices[0], choices[1]],
      [choices[2]],
      pager,
      [{ text: '« Назад', callback_data: 'back' }],
    ]);
  });
});
