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
    ['LOG_LEVEL', 'loud'],
  ])('names %s when it is invalid', (name, value) => {
    expect(() => loadConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
  });
});
