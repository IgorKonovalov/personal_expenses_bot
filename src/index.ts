import { randomUUID } from 'node:crypto';
import { adminNotifier } from './bot/adminNotifier.js';
import { createBot, registerCommands } from './bot/bot.js';
import { createDonationLinks, type DonationLinks } from './bot/handlers/donate.js';
import { messages } from './bot/messages.js';
import { startReceiptWorker } from './bot/receiptWorker.js';
import { recurringProvider } from './bot/recurringProvider.js';
import { summaryProvider } from './bot/summaryProvider.js';
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
import { register } from './scheduler/types.js';
import { startScheduler } from './scheduler/worker.js';
import { admitTelegramIds } from './services/admission.js';
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
// The admin and ADMIT_TELEGRAM_IDS (ADR-0024). Idempotent: an admitted id keeps its admitted_at.
const admitted = admitTelegramIds(
  {
    db,
    newId: randomUUID,
    adminTelegramId: config.adminTelegramId,
    defaultTimezone: config.defaultTimezone,
    defaultCurrency: config.defaultCurrency,
  },
  [config.adminTelegramId, ...config.admitTelegramIds],
  new Date(),
);
logger.info({ admitted }, 'boot admissions checked');

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
const keys = createLedgerKeyring(() => new Date());

// Filled once the bot's API exists; /donate reads it on every call.
const donationLinks: DonationLinks = new Map();

const bot = createBot({
  token: config.botToken,
  adminTelegramId: config.adminTelegramId,
  backupKeep: config.backupKeep,
  logger,
  db,
  newId: randomUUID,
  now: () => new Date(),
  defaultTimezone: config.defaultTimezone,
  defaultCurrency: config.defaultCurrency,
  keys,
  donationLinks,
  donateUrl: config.donateUrl,
  webappUrl: config.webappUrl,
  // Late-bound: the notifier needs bot.api, built just below. No update is handled before
  // polling starts.
  notifyAdmin: (body) => notifyAdmin(body),
});
const notifyAdmin = adminNotifier(bot.api, config.adminTelegramId);

await registerCommands(bot, logger, config.adminTelegramId);
// The Stars invoice links (ADR-0027). A failed preset is left out, and boot continues.
await createDonationLinks(bot.api, logger, donationLinks);

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

// Per-ledger jobs at 09:00 local (ADR-0031): a tick now, then every minute. Recurring rules,
// then the summary pushes.
const scheduledDeps = {
  db,
  logger,
  newId: randomUUID,
  now: () => new Date(),
  defaultTimezone: config.defaultTimezone,
  defaultCurrency: config.defaultCurrency,
  keys,
};
const scheduler = startScheduler({
  logger,
  now: () => new Date(),
  providers: [
    register(recurringProvider(scheduledDeps, bot.api)),
    register(summaryProvider(scheduledDeps, bot.api)),
  ],
});

// Not awaited: a slow or refused send must not delay polling. announceVersion never rejects.
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
// fetches in flight and the scheduler's tick in flight, then polling and any backup in flight,
// then the DB. With nothing left on the event loop the process exits 0 on its own.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping');
    heartbeat.stop();
    const backupSettled = backups?.stop();
    void Promise.all([receiptWorker.stop(), rateWorker.stop(), scheduler.stop()])
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
