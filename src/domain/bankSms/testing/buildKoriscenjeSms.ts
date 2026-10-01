// Test-only: builds a synthetic `Koriscenje kartice` SMS. Every value is made up: nothing here is
// a real card, balance or purchase.

export interface KoriscenjeSmsFields {
  readonly header?: string;
  readonly datum?: string;
  readonly iznos?: string;
  readonly raspolozivo?: string;
  // `null` leaves the line out.
  readonly mesto?: string | null;
  readonly lineEnd?: '\n' | '\r\n';
}

export const KORISCENJE_DEFAULTS = {
  header: 'Koriscenje kartice 1234**5678',
  // 2026-09-14T22:30:00Z
  datum: '15.09.2026 00:30:00',
  iznos: '6,00 USD',
  raspolozivo: '1.234,56 RSD',
  mesto: 'EXAMPLE.COM +100000 NL',
} as const;

export function buildKoriscenjeSms(fields: KoriscenjeSmsFields = {}): string {
  const mesto = fields.mesto === undefined ? KORISCENJE_DEFAULTS.mesto : fields.mesto;
  return [
    fields.header ?? KORISCENJE_DEFAULTS.header,
    `Datum: ${fields.datum ?? KORISCENJE_DEFAULTS.datum}`,
    `Iznos: ${fields.iznos ?? KORISCENJE_DEFAULTS.iznos}`,
    `Raspolozivo: ${fields.raspolozivo ?? KORISCENJE_DEFAULTS.raspolozivo}`,
    ...(mesto === null ? [] : [`Mesto: ${mesto}`]),
  ].join(fields.lineEnd ?? '\n');
}
