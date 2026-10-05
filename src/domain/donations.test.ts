import { describe, expect, it } from 'vitest';
import {
  DONATION_PRESETS,
  acceptsDonation,
  donationPayload,
  parseDonationPayload,
} from './donations.js';

describe('parseDonationPayload', () => {
  it('reads a preset amount', () => {
    expect(parseDonationPayload('donate:150')).toBe(150);
  });

  it.each(['donate:149', 'donate:', 'donate:1e2', 'other:150', 'donate:0150', 'donate:150 '])(
    'refuses %j',
    (payload) => {
      expect(parseDonationPayload(payload)).toBeUndefined();
    },
  );

  it('round-trips every preset through its payload', () => {
    for (const preset of DONATION_PRESETS) {
      expect(parseDonationPayload(donationPayload(preset))).toBe(preset);
    }
  });
});

describe('acceptsDonation', () => {
  it('approves XTR, 150, donate:150', () => {
    expect(acceptsDonation({ currency: 'XTR', totalAmount: 150, payload: 'donate:150' })).toBe(
      true,
    );
  });

  it('rejects a total that differs from the payload preset', () => {
    expect(acceptsDonation({ currency: 'XTR', totalAmount: 50, payload: 'donate:150' })).toBe(
      false,
    );
  });

  it('rejects a currency other than XTR', () => {
    expect(acceptsDonation({ currency: 'USD', totalAmount: 150, payload: 'donate:150' })).toBe(
      false,
    );
  });

  it('rejects a payload naming no preset', () => {
    expect(acceptsDonation({ currency: 'XTR', totalAmount: 149, payload: 'donate:149' })).toBe(
      false,
    );
  });
});
