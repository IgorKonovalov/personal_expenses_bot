import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { messages } from './messages.js';

// The list pager of ADR-0011: a list of more than PAGE_SIZE choices pages with [◀] [n/N] [▶].
// Pages are 1-based.

export const PAGE_SIZE = 8;

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
}

// The requested page, clamped into range: a stale page number past the end shows the last page.
export function pageOf<T>(items: readonly T[], requested: number, size = PAGE_SIZE): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(1, requested), pageCount);
  return { items: items.slice((page - 1) * size, page * size), page, pageCount };
}

// [◀] [n/N] [▶], without [◀] on the first page and [▶] on the last. [n/N] re-renders the page it
// shows. Empty when everything fits on one page.
export function pagerRow(
  { page, pageCount }: Pick<Page<unknown>, 'page' | 'pageCount'>,
  dataFor: (page: number) => string,
): InlineKeyboardButton[] {
  if (pageCount <= 1) return [];
  return [
    ...(page > 1 ? [InlineKeyboard.text(messages.pagerPrev, dataFor(page - 1))] : []),
    InlineKeyboard.text(messages.pagerPosition(page, pageCount), dataFor(page)),
    ...(page < pageCount ? [InlineKeyboard.text(messages.pagerNext, dataFor(page + 1))] : []),
  ];
}

// Choice buttons two per row, then the pager row when there is one, then [« Назад] alone.
export function pickerKeyboard(
  choices: readonly InlineKeyboardButton[],
  pager: readonly InlineKeyboardButton[],
  backData: string,
): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < choices.length; i += 2) rows.push(choices.slice(i, i + 2));
  if (pager.length > 0) rows.push([...pager]);
  rows.push([InlineKeyboard.text(messages.backButton, backData)]);
  return InlineKeyboard.from(rows);
}
