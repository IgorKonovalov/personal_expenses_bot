import { randomUUID } from 'node:crypto';
import { createBot, registerCommands } from './bot/bot.js';
import { loadConfig } from './config.js';
import { startBackups, type BackupSchedule } from './db/backup.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createHeartbeat, heartbeatPath } from './heartbeat.js';
import { createLogger } from './logger.js';
import { seedLedgersWithoutCategories } from './services/seedCategories.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);

const db = openDatabase(config.databasePath);
const applied = runMigrations(db, new Date());
logger.info({ node: process.version, applied }, 'migrations checked');
const seeded = seedLedgersWithoutCategories(db, new Date());
logger.info({ ledgers: seeded.length }, 'categories seeded');

const backups: BackupSchedule | undefined =
  config.backupDir === undefined
    ? undefined
    : startBackups({
        db,
        dir: config.backupDir,
        keep: config.backupKeep,
        now: () => new Date(),
        logger,
      });
if (backups === undefined) logger.info('backups off: BACKUP_DIR unset');

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

const heartbeat = createHeartbeat(heartbeatPath(config.databasePath), (error) => {
  logger.warn(
    { err: error instanceof Error ? error.name : typeof error },
    'heartbeat write failed',
  );
});

// Shutdown order: the heartbeat and backup timers, then polling and any backup in flight, then
// the DB. With nothing left on the event loop the process exits 0 on its own.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping');
    heartbeat.stop();
    const backupSettled = backups?.stop();
    void Promise.all([bot.stop(), backupSettled]).finally(() => {
      db.close();
      logger.info('stopped');
    });
  });
}

await bot.start({
  onStart: (me) => {
    logger.info({ botId: me.id }, 'bot started (long polling)');
    heartbeat.start();
  },
});
