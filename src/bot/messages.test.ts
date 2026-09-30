import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from '../domain/version.js';
import { readAppVersion } from '../version.js';
import { messages } from './messages.js';
import { html } from './render/html.js';

describe('version announcements (ADR-0013)', () => {
  // The gate: a version bump in package.json without its announcement fails the suite.
  it('has an entry for the version in package.json', () => {
    const current = readAppVersion();

    expect(Object.keys(messages.versionAnnouncements)).toContain(current);
    expect(messages.versionAnnouncements[current]?.trim()).not.toBe('');
  });

  it('keys every entry by an X.Y.Z version no greater than package.json', () => {
    const current = readAppVersion();

    for (const version of Object.keys(messages.versionAnnouncements)) {
      expect(parseVersion(version), version).toBeDefined();
      expect(compareVersions(version, current), version).toBeLessThanOrEqual(0);
    }
  });

  it('wraps a body in the version header and the /changelog pointer', () => {
    expect(messages.versionAnnouncement('0.3.0', html`<b>Что-то</b> новое`)).toBe(
      '🆕 Версия 0.3.0\n\n<b>Что-то</b> новое\n\nВсе изменения: /changelog',
    );
  });
});
