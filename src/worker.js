// Only needed in Redis mode (REDIS_URL set). Runs jobs from the Redis queue and replies on
// Slack/Telegram directly (the bot process keeps handling incoming messages and buttons).
import 'dotenv/config';
import { Worker } from 'bullmq';
import { getConnection, QUEUE, CONCURRENCY, useRedis } from './queue.js';
import { processJob } from './runner.js';
import { log } from './log.js';
import { slackEnabled, registerSlackSender } from './adapters/slack.js';
import { telegramEnabled, registerTelegramSender } from './adapters/telegram.js';

if (!useRedis) {
  log.info('REDIS_URL is not set; the bot runs jobs itself, no worker needed');
  process.exit(0);
}

if (slackEnabled()) registerSlackSender();
if (telegramEnabled()) registerTelegramSender();

new Worker(QUEUE, async (job) => processJob(job.data), {
  connection: await getConnection(),
  concurrency: CONCURRENCY,
});

log.info('worker running', { concurrency: CONCURRENCY });
