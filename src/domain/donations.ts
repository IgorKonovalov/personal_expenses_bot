// Donations in Telegram Stars (ADR-0027). Stars are a whole-unit count, not money: they never
// enter a ledger, a total or a conversion.

export const DONATION_PRESETS = [50, 150, 500] as const;
export type DonationPreset = (typeof DONATION_PRESETS)[number];

// Telegram's currency code for Stars.
export const STARS_CURRENCY = 'XTR';

export function donationPayload(stars: DonationPreset): string {
  return `donate:${stars}`;
}

// The preset an invoice payload names, or undefined for anything that isn't exactly
// `donate:<preset>` in plain decimal digits.
export function parseDonationPayload(payload: string): DonationPreset | undefined {
  const digits = /^donate:([1-9]\d*)$/.exec(payload)?.[1];
  if (digits === undefined) return undefined;
  const stars = Number(digits);
  return DONATION_PRESETS.find((preset) => preset === stars);
}

// A pre-checkout is approved only for Stars, a known preset, and a total equal to that preset.
// A link minted before a preset change carries a payload the current presets don't name.
export function acceptsDonation(query: {
  readonly currency: string;
  readonly totalAmount: number;
  readonly payload: string;
}): boolean {
  return (
    query.currency === STARS_CURRENCY && parseDonationPayload(query.payload) === query.totalAmount
  );
}
