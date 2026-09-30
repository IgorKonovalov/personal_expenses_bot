import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from './version.js';

describe('parseVersion', () => {
  it('reads X.Y.Z', () => {
    expect(parseVersion('0.10.2')).toEqual({ major: 0, minor: 10, patch: 2 });
  });

  it.each(['0.3', '0.3.0.1', 'v0.3.0', '0.3.0-rc.1', '01.0.0', '', '0.3.x'])(
    'rejects %j',
    (text) => {
      expect(parseVersion(text)).toBeUndefined();
    },
  );
});

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.3.1', '0.3.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('is zero for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('throws on an invalid version', () => {
    expect(() => compareVersions('0.3', '0.3.0')).toThrow(/X\.Y\.Z/);
  });
});
