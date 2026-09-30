// Release versions are plain `X.Y.Z`: no pre-release or build suffix, no leading zeros.

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (match === null) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch };
}

// Negative, zero or positive as `a` sorts before, with or after `b`, component by component, so
// `0.10.0` follows `0.9.0`. Both must be valid versions; anything else is a caller bug.
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) {
    throw new Error(`compareVersions needs X.Y.Z versions`);
  }
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}
