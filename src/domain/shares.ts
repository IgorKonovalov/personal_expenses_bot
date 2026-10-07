// Each amount's share of their sum in whole percents, by the largest-remainder method: every
// share starts at its floor, and the points left to reach 100 go one each to the largest
// remainders, a tie going to the earlier amount. The result sums to exactly 100. All in integer
// arithmetic on non-negative safe integers; BigInt keeps `amount × 100` exact past 2^53.
// Throws on a negative or unsafe amount, or a sum that isn't positive.
export function sharesOf(amounts: readonly number[]): number[] {
  let sum = 0n;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError('amounts must be non-negative safe integers');
    }
    sum += BigInt(amount);
  }
  if (sum <= 0n) throw new RangeError('the amounts must have a positive sum');
  const parts = amounts.map((amount, index) => {
    const scaled = BigInt(amount) * 100n;
    return { index, floor: scaled / sum, remainder: scaled % sum };
  });
  const shares = parts.map((part) => Number(part.floor));
  let left = 100 - shares.reduce((total, share) => total + share, 0);
  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const part of byRemainder) {
    if (left === 0) break;
    shares[part.index] = (shares[part.index] ?? 0) + 1;
    left--;
  }
  return shares;
}
