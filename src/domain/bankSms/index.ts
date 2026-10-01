import { parseKoriscenjeKartice } from './koriscenjeKartice.js';
import type { BankSmsResult } from './types.js';

// The parsers of the bank SMS templates we read, one per template (ADR-0021).
const TEMPLATES: readonly ((text: string) => BankSmsResult)[] = [parseKoriscenjeKartice];

// The first template that recognises the text decides. Text no template recognises is
// `notBankSms`.
export function parseBankSms(text: string): BankSmsResult {
  for (const parse of TEMPLATES) {
    const result = parse(text);
    if (result.kind !== 'notBankSms') return result;
  }
  return { kind: 'notBankSms' };
}
