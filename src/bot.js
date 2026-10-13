// Entry point: starts every chat platform that has credentials in .env (Slack, Telegram or both).
// Agents, memory, budget and logs are shared, so the same team answers on both.
import 'dotenv/config';
import { log, announceAlerts } from './log.js';
import { slackEnabled, startSlack } from './adapters/slack.js';
import { telegramEnabled, startTelegram } from './adapters/telegram.js';
import { useRedis } from './queue.js';
import { agents, agentNames } from './agents.js';
import { integrationStatus } from './integrations/index.js';
import { runningPlatforms } from './platforms.js';
import { startRoutines } from './routines.js';

if (slackEnabled()) await startSlack();
else log.info('Slack not configured (SLACK_BOT_TOKEN / SLACK_APP_TOKEN); skipping');

if (telegramEnabled()) await startTelegram();
else log.info('Telegram not configured (TELEGRAM_OWNER_ID + TELEGRAM_TOKEN_<NAME>); skipping');

if (!runningPlatforms().length) {
  log.error('No chat platform configured. Add Slack and/or Telegram settings to .env');
  process.exit(1);
}

startRoutines();

const team = agentNames.map((k) => agents[k].name).join(', ');
await announceAlerts(`🟢 Team online on ${runningPlatforms().join(' + ')} · ${team} · errors will be posted here`);
log.info('team online', { platforms: runningPlatforms().join('+'), queue: useRedis ? 'redis' : 'built-in', agents: team,
  accounts: integrationStatus().replace(/\*/g, '').replace(/`/g, '') });
