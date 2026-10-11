// Only needed in Redis mode (REDIS_URL set). Runs jobs from the Redis queue.
import 'dotenv/config';
import { Worker } from 'bullmq';
import { getConnection, QUEUE, CONCURRENCY, useRedis } from './queue.js';
import { processJob } from './runner.js';
import { log } from './log.js';

if (!useRedis) {
  log.info('REDIS_URL is not set; the bot runs jobs itself, no worker needed');
  process.exit(0);
}

new Worker(QUEUE, async (job) => processJob(job.data), {
  connection: await getConnection(),
  concurrency: CONCURRENCY,
});

log.info('worker running', { concurrency: CONCURRENCY });
