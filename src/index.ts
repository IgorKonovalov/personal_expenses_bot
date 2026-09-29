import { createBot } from './bot/bot.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const bot = createBot({
  token: config.botToken,
  allowedTelegramIds: config.allowedTelegramIds,
  logger,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'stopping');
    void bot.stop();
  });
}

await bot.start({
  onStart: (me) => {
    logger.info({ botId: me.id }, 'bot started (long polling)');
  },
});
