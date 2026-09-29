import { randomUUID } from 'node:crypto';
import { createBot } from './bot/bot.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { toCurrencyCode } from './domain/currencies.js';
import { createLogger } from './logger.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

const defaultCurrency = toCurrencyCode(config.defaultCurrency);
if (defaultCurrency === undefined) {
  throw new Error(`DEFAULT_CURRENCY ${config.defaultCurrency} is not in src/domain/currencies.ts`);
}

const db = openDatabase(config.databasePath);
const applied = runMigrations(db, new Date());
logger.info({ applied }, 'migrations checked');

const bot = createBot({
  token: config.botToken,
  allowedTelegramIds: config.allowedTelegramIds,
  logger,
  db,
  newId: randomUUID,
  now: () => new Date(),
  defaultTimezone: config.defaultTimezone,
  defaultCurrency,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping');
    void bot.stop().finally(() => {
      db.close();
    });
  });
}

await bot.start({
  onStart: (me) => {
    logger.info({ botId: me.id }, 'bot started (long polling)');
  },
});
