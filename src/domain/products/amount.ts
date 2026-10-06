// How much of a product an item bought, and what that cost per unit (ADR-0039). Every amount is
// an exact integer: thousandths of a millilitre, a gram or a piece. This module is the only place
// that reads a quantity, divides an amount or converts between bigint and number; the rest of the
// products code adds amounts up and passes them here.

export type Unit = 'l' | 'kg' | 'pcs';

// Thousandths of ml, g or pieces: an exact integer, never a float.
export type AmountMilli = bigint;

// A size as written on the item, in thousandths of the base unit, per written unit.
const WRITTEN: Readonly<Record<string, { readonly unit: Unit; readonly perBase: bigint }>> = {
  l: { unit: 'l', perBase: 1000n },
  ml: { unit: 'l', perBase: 1n },
  kg: { unit: 'kg', perBase: 1000n },
  g: { unit: 'kg', perBase: 1n },
  gr: { unit: 'kg', perBase: 1n },
  kom: { unit: 'pcs', perBase: 1n },
};

// Base units in one l, kg or piece: the divisor of a unit price.
const BASE_PER_UNIT: Readonly<Record<Unit, bigint>> = { l: 1000n, kg: 1000n, pcs: 1n };

const SIZE = String.raw`(\d+)(?:[.,](\d{1,3}))?\s?(ml|l|kg|gr|g|kom)(?![\p{L}\p{N}])`;
const MULTIPACK = new RegExp(String.raw`(?<![\p{L}\p{N}.,])(\d+)\s?x\s?${SIZE}`, 'u');
const SINGLE = new RegExp(String.raw`(?<![\p{N}.,])${SIZE}`, 'u');
// A weighed item: no size in the name, which ends with `/kg`, and `quantity` is the weight.
const WEIGHED = /\/\s?kg$/;

// `2`, `0.535` or `1,5` as thousandths: 2000, 535, 1500. More than three decimals, or anything
// that isn't a plain decimal, is undefined.
export function quantityMilli(quantity: string): bigint | undefined {
  const match = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(quantity.trim());
  if (match === null) return undefined;
  const [, whole = '', fraction = ''] = match;
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function sizeOf(match: RegExpExecArray, offset: number, unit: Unit): bigint | undefined {
  const whole = match[offset] ?? '';
  const fraction = match[offset + 1] ?? '';
  const written = WRITTEN[match[offset + 2] ?? ''];
  if (written?.unit !== unit) return undefined;
  return (BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))) * written.perBase;
}

// The pack size a normalized name carries, in thousandths of the base unit. Undefined for a name
// without one, or with one in another dimension than `unit` (grams on a litre product).
function packSize(nameKey: string, unit: Unit): bigint | undefined {
  const multipack = MULTIPACK.exec(nameKey);
  if (multipack !== null) {
    const size = sizeOf(multipack, 2, unit);
    return size === undefined ? undefined : BigInt(multipack[1] ?? '0') * size;
  }
  const single = SINGLE.exec(nameKey);
  return single === null ? undefined : sizeOf(single, 1, unit);
}

// Integer division rounding half up, for non-negative operands.
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

// What an item bought: its quantity of packs times the pack size, or for a weighed kg item, its
// quantity in kilograms. Undefined when neither is readable: the item counts in spend only.
export function amountOf(nameKey: string, quantity: string, unit: Unit): AmountMilli | undefined {
  const count = quantityMilli(quantity);
  if (count === undefined) return undefined;
  const size = packSize(nameKey, unit);
  if (size !== undefined) return divideHalfUp(count * size, 1000n);
  if (unit === 'kg' && WEIGHED.test(nameKey)) return count * 1000n;
  return undefined;
}

function toSafeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('amount out of the safe integer range');
  return result;
}

// Minor units per l, kg or piece, rounded half up: total * 10^6 / amount for l and kg, total *
// 10^3 / amount for pieces. Undefined for a zero amount.
export function unitPriceMinor(
  totalMinor: number,
  amount: AmountMilli,
  unit: Unit,
): number | undefined {
  if (amount <= 0n) return undefined;
  const perUnit = BASE_PER_UNIT[unit] * 1000n;
  return toSafeNumber(divideHalfUp(BigInt(totalMinor) * perUnit, amount));
}

// An amount in l, kg or pieces with at most three decimals and no trailing zeros: `2`, `1.245`,
// `2.2`. A litre or kilogram amount is rounded half up to the millilitre or gram first.
export function formatAmount(amount: AmountMilli, unit: Unit): string {
  const thousandths = unit === 'pcs' ? amount : divideHalfUp(amount, 1000n);
  const whole = thousandths / 1000n;
  const fraction = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}
