// The timezone picker's cities, in display order. Callbacks carry the slug, never a list index,
// so reordering or removing an entry never remaps a stale button. Labels live in the messages
// module. A slug is at most 20 ASCII bytes (timezones.test.ts pins it).
export const TIMEZONES = [
  { slug: 'belgrade', iana: 'Europe/Belgrade' },
  { slug: 'podgorica', iana: 'Europe/Podgorica' },
  { slug: 'moscow', iana: 'Europe/Moscow' },
  { slug: 'almaty', iana: 'Asia/Almaty' },
  { slug: 'kaliningrad', iana: 'Europe/Kaliningrad' },
  { slug: 'samara', iana: 'Europe/Samara' },
  { slug: 'yekaterinburg', iana: 'Asia/Yekaterinburg' },
  { slug: 'novosibirsk', iana: 'Asia/Novosibirsk' },
  { slug: 'vladivostok', iana: 'Asia/Vladivostok' },
  { slug: 'tbilisi', iana: 'Asia/Tbilisi' },
  { slug: 'yerevan', iana: 'Asia/Yerevan' },
] as const;

export type TimezoneEntry = (typeof TIMEZONES)[number];
export type TimezoneSlug = TimezoneEntry['slug'];

export function timezoneBySlug(slug: string): TimezoneEntry | undefined {
  return TIMEZONES.find((entry) => entry.slug === slug);
}

export function timezoneByIana(iana: string): TimezoneEntry | undefined {
  return TIMEZONES.find((entry) => entry.iana === iana);
}

// A named zone as the runtime's tzdata spells it: `asia/tbilisi` -> `Asia/Tbilisi`. Undefined for
// anything Intl doesn't know, and for UTC offsets like `+03:00`, which Intl accepts as a zone but
// which don't follow DST or political changes.
export function canonicalTimezone(raw: string): string | undefined {
  const name = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return undefined;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// The zone to compute local dates in: the stored one, or the fallback when the stored value is
// not a zone this runtime knows.
export function resolveTimezone(
  stored: string,
  fallback: string,
): { readonly tz: string; readonly fellBack: boolean } {
  return canonicalTimezone(stored) === undefined
    ? { tz: fallback, fellBack: true }
    : { tz: stored, fellBack: false };
}
