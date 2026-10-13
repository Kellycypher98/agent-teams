// Job queue with two modes:
//  - No REDIS_URL (default): built-in in-memory queue. One process, zero setup.
//    Jobs in flight are lost if you stop the bot.
//  - REDIS_URL set: BullMQ on Redis. Run `npm run worker` alongside the bot.
import 'dotenv/config';

export const QUEUE = 'agent-tasks';
export const CONCURRENCY = process.env.CONCURRENCY != null && process.env.CONCURRENCY !== '' ? Number(process.env.CONCURRENCY) : 3; // 3 so a whole standup runs at once
export const useRedis = Boolean(process.env.REDIS_URL);

let nextId = 1;
const pending = [];
let running = 0;

async function pump() {
  while (running < CONCURRENCY && pending.length) {
    const data = pending.shift();
    running++;
    const { processJob } = await import('./runner.js');
    processJob(data).finally(() => {
      running--;
      pump();
    });
  }
}

let bullQueue;
export async function getConnection() {
  const { default: IORedis } = await import('ioredis');
  return new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function enqueue(data) {
  if (useRedis) {
    if (!bullQueue) {
      const { Queue } = await import('bullmq');
      bullQueue = new Queue(QUEUE, { connection: await getConnection() });
    }
    const job = await bullQueue.add(data.agent, data);
    return job.id;
  }
  const id = nextId++;
  pending.push(data);
  pump();
  return id;
}

// For tests/debugging: jobs waiting in the built-in queue.
export const pendingJobs = () => pending;
