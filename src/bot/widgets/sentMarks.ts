// The already-sent memo behind a chart button (ADR-0053): a repeat tap with the same data on the
// same message sends nothing. A mark is the tapper's Telegram id, the tapped message id and the
// callback data. It lives in this process: a restart forgets every mark, which can let one
// repeat through as a duplicate picture that records nothing.

export const SENT_MARK_TTL_MS = 24 * 60 * 60 * 1000;
export const SENT_MARK_CAPACITY = 10_000;

export interface SentMarks {
  // True, and the mark is set, when no live mark exists for the key.
  mark(key: string): boolean;
  // Drops a mark: the send it guarded failed, so a new tap may try again.
  forget(key: string): void;
}

export function sentMarkKey(telegramId: number, messageId: number, data: string): string {
  return `${telegramId}:${messageId}:${data}`;
}

export function createSentMarks(
  now: () => Date,
  ttlMs = SENT_MARK_TTL_MS,
  capacity = SENT_MARK_CAPACITY,
): SentMarks {
  // Insertion order is age order: a re-marked key is deleted before it is set again.
  const marks = new Map<string, number>();
  return {
    mark(key) {
      const at = now().getTime();
      const marked = marks.get(key);
      if (marked !== undefined && at - marked < ttlMs) return false;
      marks.delete(key);
      marks.set(key, at);
      // Expired marks at the front go first, then the oldest past capacity.
      for (const [oldest, then] of marks) {
        if (at - then < ttlMs && marks.size <= capacity) break;
        marks.delete(oldest);
      }
      return true;
    },
    forget(key) {
      marks.delete(key);
    },
  };
}
