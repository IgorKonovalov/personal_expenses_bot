import { readFileSync } from 'node:fs';

// `package.json` sits one level above both src/ (tsx) and dist/ (Docker copies it to /app), so the
// same relative URL finds it in dev and in production.
const PACKAGE_JSON = new URL('../package.json', import.meta.url);

// The running release, read once at boot.
export function readAppVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== 'string') throw new Error('package.json has no string version');
  return version;
}
