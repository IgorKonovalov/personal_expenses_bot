import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { compareVersions, parseVersion } from '../domain/version.js';
import { readAppVersion } from '../version.js';
import { messages } from './messages.js';
import { html } from './render/html.js';

describe('/help', () => {
  it('mentions past dates, the card buttons, receipts and /cancel, within one message', () => {
    expect(messages.help).toContain('«450 такси вчера»');
    expect(messages.help).toContain('[Категория]');
    expect(messages.help).toContain('[Изменить]');
    expect(messages.help).toContain('Чек из Сербии или Черногории');
    expect(messages.help).toContain('фото QR-кода');
    expect(messages.help).toContain('/cancel — отменить ввод');
    // HTML length bounds the visible length Telegram counts.
    expect(messages.help.length).toBeLessThan(4096);
  });
});

describe('periodSummary folds its category lines (ADR-0038)', () => {
  const week = {
    ledger: { kind: 'personal', name: '' },
    period: { kind: 'week', from: '2026-10-05' as LocalDate, to: '2026-10-11' as LocalDate },
  } as const;

  it('puts the bold total above one expandable quote holding the categories by amount', () => {
    const text = messages.periodSummary({
      ...week,
      currencies: [
        {
          currency: 'RSD',
          totalMinor: 113298,
          lines: [
            { name: 'Еда', amountMinor: 61398 },
            { name: 'Дом', amountMinor: 39900 },
            { name: 'Транспорт', amountMinor: 12000 },
          ],
        },
      ],
    });

    expect(text).toBe(
      '<b>Неделя, 5–11 октября — «Личные расходы»</b>\n\n' +
        '<b>1 132.98 RSD</b>\n' +
        '<blockquote expandable>Еда: 613.98\nДом: 399.00\nТранспорт: 120.00</blockquote>',
    );
  });

  it('renders a period with no expenses as the header and the no-expenses line', () => {
    expect(messages.periodSummary({ ...week, currencies: [] })).toBe(
      '<b>Неделя, 5–11 октября — «Личные расходы»</b>\nТрат нет. Отправьте, например, «450 кофе».',
    );
  });
});

describe('/prices (ADR-0039)', () => {
  it('renders a product by month, newest first, with every currency, then all time', () => {
    const text = messages.productView({
      ledger: { kind: 'shared', name: 'Семья' },
      name: 'Молоко',
      months: [
        { month: '2026-10', amountMinor: 45700, currency: 'RSD' },
        { month: '2026-10', amountMinor: 250, currency: 'EUR' },
        { month: '2025-12', amountMinor: 27800, currency: 'RSD' },
      ],
      totals: [
        { amountMinor: 73500, currency: 'RSD' },
        { amountMinor: 250, currency: 'EUR' },
      ],
    });

    expect(text).toBe(
      '<b>Молоко — «Семья»</b>\nОктябрь 2026: 457.00 RSD\nОктябрь 2026: 2.50 EUR\n' +
        'Декабрь 2025: 278.00 RSD\n\nВсего: 735.00 RSD, 2.50 EUR',
    );
  });

  it('lists /prices in the help text', () => {
    expect(messages.help).toContain('/prices — цены продуктов из чеков по месяцам');
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

  // Five of them plus the header and the link stay under Telegram's 4096 characters.
  it('keeps every entry within 700 characters of HTML', () => {
    for (const [version, body] of Object.entries(messages.versionAnnouncements))
      expect(body.length, version).toBeLessThanOrEqual(700);
  });

  it('wraps a body in the version header and the /changelog pointer', () => {
    expect(messages.versionAnnouncement('0.3.0', html`<b>Что-то</b> новое`)).toBe(
      '🆕 Версия 0.3.0\n\n<b>Что-то</b> новое\n\nВсе изменения: /changelog',
    );
  });
});
