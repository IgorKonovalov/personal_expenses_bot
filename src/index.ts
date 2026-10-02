import { randomUUID } from 'node:crypto';
import { adminNotifier } from './bot/adminNotifier.js';
import { createBot, registerCommands } from './bot/bot.js';
import { messages } from './bot/messages.js';
import { startReceiptWorker } from './bot/receiptWorker.js';
import { loadConfig } from './config.js';
import { startBackups, type BackupSchedule } from './db/backup.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createMeFetcher } from './fiscal/meFetcher.js';
import { createRsFetcher } from './fiscal/rsFetcher.js';
import { createNbsFetcher } from './fx/nbsFetcher.js';
import { startRateWorker } from './fx/rateWorker.js';
import { createHeartbeat, heartbeatPath } from './heartbeat.js';
import { createLogger } from './logger.js';
import { announceVersion } from './services/announceVersion.js';
import { createLedgerKeyring } from './services/ledgerKeys.js';
import { seedLedgersWithoutCategories } from './services/seedCategories.js';
import { readAppVersion } from './version.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const appVersion = readAppVersion();
logger.info({ version: appVersion }, 'booting');

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

// Unlocked sealed-ledger keys live only in this process: a restart locks every ledger.
const keys = createLedgerKeyring();

const bot = createBot({
  token: config.botToken,
  allowedTelegramIds: config.allowedTelegramIds,
  logger,
  db,
  newId: randomUUID,
  now: () => new Date(),
  defaultTimezone: config.defaultTimezone,
  defaultCurrency: config.defaultCurrency,
  keys,
});

await registerCommands(bot, logger);

// Receipt line items arrive from the tax sites in the background (ADR-0018).
const receiptWorker = startReceiptWorker(
  {
    db,
    logger,
    newId: randomUUID,
    now: () => new Date(),
    defaultTimezone: config.defaultTimezone,
    defaultCurrency: config.defaultCurrency,
    keys,
    fetchers: { RS: createRsFetcher(), ME: createMeFetcher() },
  },
  bot.api,
);

// NBS middle rates for converted totals and budgets (ADR-0022): a tick now, then hourly.
const rateWorker = startRateWorker({
  db,
  logger,
  now: () => new Date(),
  fetchList: createNbsFetcher(),
});

// Not awaited: a slow or refused send must not delay polling. announceVersion never rejects.
const notifyAdmin = adminNotifier(bot.api, config.adminTelegramId);
void announceVersion(
  {
    db,
    logger,
    announcements: messages.versionAnnouncements,
    send: (version, body) => notifyAdmin(messages.versionAnnouncement(version, body)),
  },
  appVersion,
);

const heartbeat = createHeartbeat(heartbeatPath(config.databasePath), (error) => {
  logger.warn(
    { err: error instanceof Error ? error.name : typeof error },
    'heartbeat write failed',
  );
});

// Shutdown order: the heartbeat and backup timers, then the receipt and rate workers and their
// fetches in flight, then polling and any backup in flight, then the DB. With nothing left on
// the event loop the process exits 0 on its own.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping');
    heartbeat.stop();
    const backupSettled = backups?.stop();
    void Promise.all([receiptWorker.stop(), rateWorker.stop()])
      .then(() => Promise.all([bot.stop(), backupSettled]))
      .finally(() => {
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
