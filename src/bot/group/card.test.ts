import { describe, expect, it } from 'vitest';
import type { ExpenseId } from '../../db/expenses.js';
import { editInDmLink } from './card.js';

describe('editInDmLink', () => {
  it('deep-links to the bot with an e_<uuid> payload of 38 bytes', () => {
    const id = '00000000-0000-4000-8000-000000000007' as ExpenseId;

    const link = new URL(editInDmLink('test_bot', id));

    expect(link.href).toBe(`https://t.me/test_bot?start=e_${id}`);
    const payload = link.searchParams.get('start') ?? '';
    expect(Buffer.byteLength(payload, 'utf8')).toBe(38);
    // Telegram accepts a start payload of up to 64 characters from [A-Za-z0-9_-].
    expect(payload).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
