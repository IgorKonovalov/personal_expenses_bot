import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { backupRetentionDays } from '../db/backup.js';
import type { LocalDate } from '../domain/time.js';
import { compareVersions, parseVersion } from '../domain/version.js';
import { GROUP_ASK_TTL_MS } from '../services/groupChats.js';
import { readAppVersion } from '../version.js';
import { DOCS_URL, messages } from './messages.js';
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

  it('names a currency sign, the к suffix and amount-last text (ADR-0046)', () => {
    expect(messages.help).toContain('«300 € ремонт»');
    expect(messages.help).toContain('«45к шкаф»');
    expect(messages.help).toContain('«Чайник 3200»');
  });
});

describe('chatImportFixBadLine', () => {
  it('quotes a line of 5000 characters cut at 100 code points', () => {
    expect(messages.chatImportFixBadLine({ n: 3, line: 'я'.repeat(5000) })).toBe(
      `Строку 3 («${'я'.repeat(100)}…») не понял. Отправьте все строки ещё раз.`,
    );
  });
});

describe('the group help (ADR-0046)', () => {
  it('names a currency sign and the к suffix', () => {
    expect(messages.groupHelp).toContain('«300 € ремонт»');
    expect(messages.groupHelp).toContain('«45к шкаф»');
  });

  it('says amount-last text gets a question only its author answers, gone after the expiry', () => {
    expect(messages.groupHelp).toContain(
      'Если сумма в конце, например «Чайник 3200», я сначала спрошу, записать ли. Ответить может ' +
        `только автор сообщения; без ответа вопрос исчезнет через ${GROUP_ASK_TTL_MS / 60_000} минут.`,
    );
  });
});

describe('the docs link (ADR-0048)', () => {
  it('is the docs path beside the Mini App', () => {
    expect(DOCS_URL).toBe('https://igorkonovalov.github.io/personal_expenses_bot/docs/');
  });

  it('closes the private help before the donate line, and the group help', () => {
    expect(messages.help).toContain(
      `Подробное руководство с примерами: ${DOCS_URL}\n${messages.helpDonateLine}`,
    );
    expect(messages.groupHelp.endsWith(`Подробное руководство с примерами: ${DOCS_URL}`)).toBe(
      true,
    );
  });
});

describe('/delete_account (ADR-0044)', () => {
  it('says deleted data stays in backups up to 28 days with the default retention', () => {
    const config = loadConfig({
      BOT_TOKEN: '123456:test-token',
      ADMIN_TELEGRAM_ID: '1001',
      DEFAULT_TIMEZONE: 'Europe/Belgrade',
      DEFAULT_CURRENCY: 'RSD',
    });
    const days = backupRetentionDays({
      keep: config.backupKeep,
      keepWeekly: config.backupKeepWeekly,
    });

    expect(messages.deleteAccountPrompt(days)).toContain('до 28 дн.');
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

describe('the summary drill-down (Plan 0037)', () => {
  const week = {
    ledger: { kind: 'personal', name: '' },
    period: { kind: 'week', from: '2026-09-28' as LocalDate, to: '2026-10-04' as LocalDate },
  } as const;

  it('names the uncategorized line and button with messages.uncategorized', () => {
    expect(messages.uncategorized).toBe('Без категории');
    expect(messages.drillCategoryButton(null)).toBe(messages.uncategorized);
    expect(
      messages.periodSummary({
        ...week,
        currencies: [
          { currency: 'RSD', totalMinor: 7000, lines: [{ name: null, amountMinor: 7000 }] },
        ],
      }),
    ).toContain(`<blockquote expandable>${messages.uncategorized}: 70.00</blockquote>`);
  });

  it('marks a converted first total with ≈ in the list header and names an unnamed author', () => {
    const text = messages.drillList({
      ledger: { kind: 'shared', name: 'Дом' },
      period: week.period,
      categoryName: null,
      totals: [
        { currency: 'RSD', amountMinor: 246194 },
        { currency: 'KZT', amountMinor: 500000 },
      ],
      convertedFrom: [{ currency: 'EUR', amountMinor: 1074 }],
      count: 21,
      lines: [
        {
          n: 9,
          occurredOn: '2026-10-01' as LocalDate,
          money: { currency: 'EUR', amountMinor: 1074 },
          description: 'такси',
          author: null,
        },
      ],
    });

    expect(text).toBe(
      '<b>Без категории · неделя, 28 сентября – 4 октября</b>\n' +
        '«Дом» · 21 трата · ≈ 2 461.94 RSD, 5 000.00 KZT\n\n' +
        '9. 1 окт — 10.74 EUR · такси · участник',
    );
  });

  it('says a week with nothing left in the category in the accusative', () => {
    expect(messages.drillListEmpty({ period: week.period, categoryName: 'Кафе' })).toBe(
      'В категории «Кафе» за неделю 28 сентября – 4 октября трат нет.',
    );
  });
});

describe('/prices (ADR-0039)', () => {
  it('renders a product by month, newest first, with every currency, then all time', () => {
    const line = (
      currency: 'RSD' | 'EUR',
      spentMinor: number,
      amount: bigint,
      unsized: number,
      unitPriceMinor: number | undefined,
    ) => ({ currency, spentMinor, amount, unsized, unitPriceMinor });

    const text = messages.productView({
      ledger: { kind: 'shared', name: 'Семья' },
      name: 'Молоко',
      unit: 'l',
      months: [
        { month: '2026-10', ...line('RSD', 45700, 2_000_000n, 1, 15350) },
        { month: '2026-10', ...line('EUR', 250, 0n, 2, undefined) },
        { month: '2025-12', ...line('RSD', 27800, 2_200_000n, 0, 12636) },
      ],
      totals: [line('RSD', 73500, 4_200_000n, 1, 14238), line('EUR', 250, 0n, 2, undefined)],
    });

    expect(text).toBe(
      '<b>Молоко — «Семья»</b>\n' +
        'Октябрь 2026: 457.00 RSD · 2 л · 153.50 RSD/л · 1 позиция без размера\n' +
        'Октябрь 2026: 2.50 EUR · 2 позиции без размера\n' +
        'Декабрь 2025: 278.00 RSD · 2.2 л · 126.36 RSD/л\n\n' +
        'Всего: 735.00 RSD · 4.2 л · 142.38 RSD/л · 1 позиция без размера\n' +
        'Всего: 2.50 EUR · 2 позиции без размера',
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
