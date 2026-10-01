import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from '../domain/version.js';
import { readAppVersion } from '../version.js';
import { messages } from './messages.js';
import { html } from './render/html.js';

describe('/help', () => {
  it('mentions past dates, the card buttons and receipts, within one message', () => {
    expect(messages.help).toContain('«450 такси вчера»');
    expect(messages.help).toContain('[Категория]');
    expect(messages.help).toContain('[Изменить]');
    expect(messages.help).toContain('Чек из Сербии или Черногории');
    expect(messages.help).toContain('фото QR-кода');
    // HTML length bounds the visible length Telegram counts.
    expect(messages.help.length).toBeLessThan(4096);
  });
});

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
