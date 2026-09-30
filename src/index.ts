import { randomUUID } from 'node:crypto';
import { createBot, registerCommands } from './bot/bot.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { seedLedgersWithoutCategories } from './services/seedCategories.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

const db = openDatabase(config.databasePath);
const applied = runMigrations(db, new Date());
logger.info({ applied }, 'migrations checked');
const seeded = seedLedgersWithoutCategories(db, new Date());
logger.info({ ledgers: seeded.length }, 'categories seeded');

const bot = createBot({
  token: config.botToken,
  allowedTelegramIds: config.allowedTelegramIds,
  logger,
  db,
  newId: randomUUID,
  now: () => new Date(),
  defaultTimezone: config.defaultTimezone,
  defaultCurrency: config.defaultCurrency,
});

await registerCommands(bot, logger);

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
