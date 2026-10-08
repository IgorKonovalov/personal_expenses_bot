import { describe, expect, it } from 'vitest';
import { redirectsToDocs } from './redirect.js';

describe('redirectsToDocs (ADR-0048)', () => {
  it.each(['', '#', '#tgWebAppData=x'])('sends %j to the docs', (hash) => {
    expect(redirectsToDocs(hash)).toBe(true);
  });

  it.each(['#z=abc', '#d=abc', '#m=scan', '#z=abc&tgWebAppData=x'])(
    'keeps %j on the page',
    (hash) => {
      expect(redirectsToDocs(hash)).toBe(false);
    },
  );
});
