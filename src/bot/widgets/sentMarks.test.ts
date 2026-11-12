import { describe, expect, it } from 'vitest';
import { SENT_MARK_CAPACITY, createSentMarks, sentMarkKey } from './sentMarks.js';

describe('sent marks', () => {
  const start = new Date('2026-11-12T13:05:00Z').getTime();

  function clockAt(ms: number) {
    const clock = { ms };
    return { clock, now: () => new Date(clock.ms) };
  }

  it('refuses a repeat within 24 hours and accepts it at +24h01m', () => {
    const { clock, now } = clockAt(start);
    const marks = createSentMarks(now);
    const key = sentMarkKey(1001, 101, 'wg:s:m:2026-11');

    expect(marks.mark(key)).toBe(true);
    clock.ms = start + 23 * 3_600_000 + 59 * 60_000;
    expect(marks.mark(key)).toBe(false);
    clock.ms = start + 24 * 3_600_000 + 60_000;
    expect(marks.mark(key)).toBe(true);
    expect(marks.mark(key)).toBe(false);
  });

  it('keys by user, message and data', () => {
    const { now } = clockAt(start);
    const marks = createSentMarks(now);

    expect(marks.mark(sentMarkKey(1001, 101, 'wg:s:m:2026-11'))).toBe(true);
    expect(marks.mark(sentMarkKey(1001, 101, 'wg:s:m:2026-10'))).toBe(true);
    expect(marks.mark(sentMarkKey(1001, 102, 'wg:s:m:2026-11'))).toBe(true);
    expect(marks.mark(sentMarkKey(1003, 101, 'wg:s:m:2026-11'))).toBe(true);
  });

  it('drops the oldest mark when the 10,001st is set', () => {
    const { clock, now } = clockAt(start);
    const marks = createSentMarks(now);
    expect(SENT_MARK_CAPACITY).toBe(10_000);
    for (let i = 1; i <= 10_001; i++) {
      clock.ms = start + i;
      expect(marks.mark(`k${i}`)).toBe(true);
    }

    // k1 is gone, so it marks again; k2 is still held.
    expect(marks.mark('k2')).toBe(false);
    expect(marks.mark('k1')).toBe(true);
  });

  it('forgets a mark on request', () => {
    const { now } = clockAt(start);
    const marks = createSentMarks(now);
    marks.mark('k');
    marks.forget('k');
    expect(marks.mark('k')).toBe(true);
  });
});
