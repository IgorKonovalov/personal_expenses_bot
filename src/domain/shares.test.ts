import { describe, expect, it } from 'vitest';
import { sharesOf } from './shares.js';

// A deterministic generator, so a failing case reruns the same.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('sharesOf', () => {
  it('gives the leftover point to the largest remainder', () => {
    // Floors 77, 19 and 3; remainders 0.419, 0.355 and 0.226.
    expect(sharesOf([120000, 30000, 5000])).toEqual([78, 19, 3]);
  });

  it('breaks a tie in remainders towards the earlier amount', () => {
    expect(sharesOf([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('gives a zero amount 0 and the only positive one 100', () => {
    expect(sharesOf([0, 5])).toEqual([0, 100]);
  });

  it('refuses a negative or fractional amount and a sum of 0', () => {
    expect(() => sharesOf([5, -1])).toThrow(RangeError);
    expect(() => sharesOf([1.5])).toThrow(RangeError);
    expect(() => sharesOf([0, 0])).toThrow(RangeError);
    expect(() => sharesOf([])).toThrow(RangeError);
  });

  it('sums to exactly 100, each share within 1 of its floor, over 500 seeded inputs', () => {
    const next = random(41);
    for (let run = 0; run < 500; run++) {
      const count = 1 + Math.floor(next() * 30);
      const scale = next() < 0.2 ? Number.MAX_SAFE_INTEGER / 64 : 1_000_000;
      const amounts = Array.from({ length: count }, () =>
        next() < 0.15 ? 0 : Math.floor(next() * scale),
      );
      if (!amounts.some((amount) => amount > 0)) amounts[0] = 1;
      const sum = amounts.reduce((total, amount) => total + BigInt(amount), 0n);

      const shares = sharesOf(amounts);

      expect(shares.reduce((total, share) => total + share, 0)).toBe(100);
      shares.forEach((share, i) => {
        const floor = Number((BigInt(amounts[i] ?? 0) * 100n) / sum);
        expect(share - floor).toBeGreaterThanOrEqual(0);
        expect(share - floor).toBeLessThanOrEqual(1);
      });
    }
  });
});
