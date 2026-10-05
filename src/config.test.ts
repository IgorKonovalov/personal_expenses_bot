import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  BOT_TOKEN: '123456:test-token',
  ALLOWED_TELEGRAM_IDS: '1001, 1002',
  DEFAULT_TIMEZONE: 'Europe/Belgrade',
  DEFAULT_CURRENCY: 'RSD',
};

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.botToken).toBe('123456:test-token');
    expect([...config.allowedTelegramIds]).toEqual([1001, 1002]);
    expect(config.defaultTimezone).toBe('Europe/Belgrade');
    expect(config.defaultCurrency).toBe('RSD');
    expect(config.databasePath).toBe('./data/bot.sqlite');
    expect(config.logLevel).toBe('info');
    expect(config.backupDir).toBeUndefined();
    expect(config.backupKeep).toBe(14);
    expect(config.donateUrl).toBeUndefined();
  });

  it('reads an https DONATE_URL', () => {
    expect(loadConfig({ ...valid, DONATE_URL: 'https://ko-fi.com/example' }).donateUrl).toBe(
      'https://ko-fi.com/example',
    );
  });

  it('takes the first allowed id as the admin', () => {
    expect(loadConfig({ ...valid, ALLOWED_TELEGRAM_IDS: '222,111' }).adminTelegramId).toBe(222);
  });

  it('reads BACKUP_DIR and BACKUP_KEEP', () => {
    const config = loadConfig({ ...valid, BACKUP_DIR: '/var/backups/x', BACKUP_KEEP: '7' });
    expect(config.backupDir).toBe('/var/backups/x');
    expect(config.backupKeep).toBe(7);
  });

  it('names BOT_TOKEN when it is unset', () => {
    const env = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'BOT_TOKEN'));
    expect('BOT_TOKEN' in env).toBe(false);
    expect(() => loadConfig(env)).toThrow(/BOT_TOKEN/);
  });

  it('names BOT_TOKEN when it is blank', () => {
    expect(() => loadConfig({ ...valid, BOT_TOKEN: '  ' })).toThrow(/BOT_TOKEN/);
  });

  it.each([
    ['ALLOWED_TELEGRAM_IDS', '1001,abc'],
    ['DEFAULT_TIMEZONE', 'Mars/Olympus'],
    ['DEFAULT_CURRENCY', 'dinar'],
    ['DEFAULT_CURRENCY', 'XYZ'],
    ['DEFAULT_CURRENCY', 'rsd'],
    ['LOG_LEVEL', 'loud'],
    ['BACKUP_KEEP', '0'],
    ['BACKUP_KEEP', 'abc'],
    ['DONATE_URL', 'http://example.com'],
    ['DONATE_URL', 'ko-fi.com/example'],
  ])('names %s when it is invalid', (name, value) => {
    expect(() => loadConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });
});
