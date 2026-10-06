// The normalized form of a receipt item name (ADR-0039): the key product rules match on and a
// per-user override is stored under. Lower case, Serbian Cyrillic transliterated to Latin,
// diacritics folded (`č` → `c`, `đ` → `dj`), whitespace collapsed. `МЛЕКО 1Л` and `Mleko 1l`
// share one key.

const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'dj',
  е: 'e',
  ж: 'z',
  з: 'z',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'c',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'c',
  џ: 'dz',
  ш: 's',
};

export function normalize(name: string): string {
  // `đ` has no decomposition; the rest (č ć š ž ś ź) lose their marks under NFD.
  return name
    .toLowerCase()
    .replace(/[а-яђјљњћџ]/g, (char) => CYRILLIC[char] ?? char)
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
