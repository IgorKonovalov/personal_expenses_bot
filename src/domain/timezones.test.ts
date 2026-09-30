import { describe, expect, it } from 'vitest';
import { localDateOf } from './time.js';
import {
  TIMEZONES,
  canonicalTimezone,
  resolveTimezone,
  timezoneByIana,
  timezoneBySlug,
} from './timezones.js';

describe('TIMEZONES', () => {
  it('has slugs of at most 20 ASCII bytes, each unique, and zones Intl knows', () => {
    for (const { slug, iana } of TIMEZONES) {
      expect(slug).toMatch(/^[a-z0-9_-]+$/);
      expect(Buffer.byteLength(slug, 'utf8')).toBeLessThanOrEqual(20);
      expect(canonicalTimezone(iana)).toBe(iana);
    }
    expect(new Set(TIMEZONES.map((t) => t.slug)).size).toBe(TIMEZONES.length);
    expect(new Set(TIMEZONES.map((t) => t.iana)).size).toBe(TIMEZONES.length);
  });

  it('includes Belgrade, Podgorica, Moscow and Almaty', () => {
    expect(timezoneBySlug('belgrade')?.iana).toBe('Europe/Belgrade');
    expect(timezoneBySlug('podgorica')?.iana).toBe('Europe/Podgorica');
    expect(timezoneBySlug('moscow')?.iana).toBe('Europe/Moscow');
    expect(timezoneBySlug('almaty')?.iana).toBe('Asia/Almaty');
  });

  it('looks entries up by slug and by zone, and misses unknown ones', () => {
    expect(timezoneByIana('Europe/Moscow')?.slug).toBe('moscow');
    expect(timezoneBySlug('mars')).toBeUndefined();
    expect(timezoneByIana('Asia/Istanbul')).toBeUndefined();
  });
});

describe('canonicalTimezone', () => {
  it('spells a zone typed in any case the way tzdata does', () => {
    expect(canonicalTimezone('asia/tbilisi')).toBe('Asia/Tbilisi');
    expect(canonicalTimezone(' Europe/Istanbul ')).toBe('Europe/Istanbul');
  });

  it.each(['Mars/Base', '+03:00', '-05:00', 'UTC+3', '', 'Europe/', '450 кофе'])(
    'refuses %j',
    (raw) => {
      expect(canonicalTimezone(raw)).toBeUndefined();
    },
  );
});

describe('resolveTimezone', () => {
  it('keeps a valid stored zone', () => {
    expect(resolveTimezone('Europe/Moscow', 'Europe/Belgrade')).toEqual({
      tz: 'Europe/Moscow',
      fellBack: false,
    });
  });

  it('falls back for a zone the runtime does not know', () => {
    expect(resolveTimezone('Mars/Base', 'Europe/Belgrade')).toEqual({
      tz: 'Europe/Belgrade',
      fellBack: true,
    });
  });
});

describe('tzdata guard', () => {
  // Kazakhstan moved to UTC+5 in 2024. Pre-2024 tzdata (UTC+6) puts 18:30Z on the 30th.
  it('puts 2026-09-29T18:30:00Z on the 29th in Asia/Almaty', () => {
    expect(localDateOf(new Date('2026-09-29T18:30:00Z'), 'Asia/Almaty')).toBe('2026-09-29');
  });
});
