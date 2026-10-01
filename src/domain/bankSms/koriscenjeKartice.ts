import { createHash } from 'node:crypto';
import { TZDate } from '@date-fns/tz';
import { toCurrencyCode } from '../currencies.js';
import { minorFromDecimal } from '../money.js';
import type { BankSmsResult } from './types.js';

// The Serbian card-purchase SMS (ADR-0021):
//
//   Koriscenje kartice 1234**5678
//   Datum: 15.09.2026 00:30:00
//   Iznos: 6,00 USD
//   Raspolozivo: 1.234,56 RSD
//   Mesto: EXAMPLE.COM +100000 NL
//
// The header is the first non-blank line. Labelled lines come in any order, with or without
// diacritics. Only `Iznos` is an amount: `Raspolozivo` is the balance and is never read.

// The bank's wall time is Serbian.
const BANK_TIMEZONE = 'Europe/Belgrade';

const HEADER = /^koriscenje kartice\s+(\S+)$/i;
const LABELLED = /^([^:]+):\s*(.*)$/;
const DATUM = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
// Digits, plain or dot-grouped in threes, a comma and exactly two digits, then the code.
const IZNOS = /^(\d+|\d{1,3}(?:\.\d{3})+),(\d{2}) ([A-Z]{3})$/;
const COUNTRY = /^[A-Z]{2}$/;
const PHONE = /^\+\d+$/;

export function parseKoriscenjeKartice(text: string): BankSmsResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [first, ...rest] = lines;
  const header = HEADER.exec(withoutDiacritics(first ?? ''));
  if (header === null) return { kind: 'notBankSms' };
  const card = header[1] ?? '';

  const labelled = new Map<string, string>();
  for (const line of rest) {
    const match = LABELLED.exec(line);
    if (match === null) continue;
    const label = withoutDiacritics(match[1] ?? '')
      .trim()
      .toLowerCase();
    if (!labelled.has(label)) labelled.set(label, match[2] ?? '');
  }

  const datum = labelled.get('datum');
  const iznos = labelled.get('iznos');
  const mesto = labelled.get('mesto');
  if (datum === undefined || iznos === undefined || mesto === undefined) return malformed();

  const issuedAt = parseDatum(datum);
  if (issuedAt === undefined) return malformed();

  const amount = IZNOS.exec(iznos);
  if (amount === null) return malformed();
  const [, integerPart = '', fraction = '', code = ''] = amount;
  const currency = toCurrencyCode(code);
  if (currency === undefined) return { kind: 'refused', reason: 'unsupportedCurrency', code };
  const amountMinor = minorFromDecimal(`${integerPart.replaceAll('.', '')}.${fraction}`, currency);
  if (amountMinor === undefined || amountMinor <= 0) return malformed();

  const place = mesto.replaceAll(/\s+/g, ' ').trim();
  if (place === '') return malformed();

  return {
    kind: 'purchase',
    template: 'koriscenje-kartice',
    issuedAt,
    amountMinor,
    currency,
    description: describe(place),
    fingerprint: createHash('sha256')
      .update([card, issuedAt.toISOString(), amountMinor, currency, place].join('\n'))
      .digest('hex'),
  };
}

// A header whose body can't be read: refused, never handed to the free-text parser.
function malformed(): BankSmsResult {
  return { kind: 'refused', reason: 'malformed' };
}

// `Š` -> `S`, `ć` -> `c`, `đ` -> `d`: Serbian Latin with its marks dropped, for matching labels.
function withoutDiacritics(text: string): string {
  return text.normalize('NFD').replaceAll(/\p{M}/gu, '').replaceAll('đ', 'd').replaceAll('Đ', 'D');
}

// `DD.MM.YYYY HH:MM:SS` in the bank's timezone, as a UTC instant. A date the calendar lacks
// (31.02) is undefined.
function parseDatum(text: string): Date | undefined {
  const match = DATUM.exec(text);
  if (match === null) return undefined;
  const [day = 0, month = 0, year = 0, hours = 0, minutes = 0, seconds = 0] = match
    .slice(1)
    .map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined;
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  return new Date(
    new TZDate(year, month - 1, day, hours, minutes, seconds, BANK_TIMEZONE).getTime(),
  );
}

// The merchant without its trailing country code and phone numbers:
// `EXAMPLE SHOP +381000000 RS` -> `EXAMPLE SHOP`. A value that is nothing but those stays whole.
function describe(place: string): string {
  const tokens = place.split(' ');
  if (COUNTRY.test(tokens.at(-1) ?? '')) tokens.pop();
  while (PHONE.test(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.length === 0 ? place : tokens.join(' ');
}
