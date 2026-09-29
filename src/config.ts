import type { Level } from 'pino';

export interface Config {
  readonly botToken: string;
  readonly allowedTelegramIds: ReadonlySet<number>;
  readonly defaultTimezone: string;
  readonly defaultCurrency: string;
  readonly databasePath: string;
  readonly logLevel: Level | 'silent';
}

type Env = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS: readonly (Level | 'silent')[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

// Parses and validates the environment once at boot. Every failure names the variable.
export function loadConfig(env: Env): Config {
  const botToken = required(env, 'BOT_TOKEN');

  const allowedTelegramIds = new Set<number>();
  for (const raw of required(env, 'ALLOWED_TELEGRAM_IDS').split(',')) {
    const id = raw.trim();
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error(`ALLOWED_TELEGRAM_IDS must be comma-separated Telegram user ids`);
    }
    allowedTelegramIds.add(Number(id));
  }

  const defaultTimezone = required(env, 'DEFAULT_TIMEZONE');
  if (!isIanaTimezone(defaultTimezone)) {
    throw new Error(`DEFAULT_TIMEZONE must be an IANA timezone such as Europe/Belgrade`);
  }

  const defaultCurrency = required(env, 'DEFAULT_CURRENCY');
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) {
    throw new Error(`DEFAULT_CURRENCY must be an ISO-4217 code such as RSD`);
  }

  const logLevel = optional(env, 'LOG_LEVEL') ?? 'info';
  if (!isLogLevel(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }

  return {
    botToken,
    allowedTelegramIds,
    defaultTimezone,
    defaultCurrency,
    databasePath: optional(env, 'DATABASE_PATH') ?? './data/bot.sqlite',
    logLevel,
  };
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function isIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isLogLevel(value: string): value is Level | 'silent' {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
