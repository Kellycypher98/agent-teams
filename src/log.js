// Tiny structured logger.
//   LOG_LEVEL=debug|info|warn|error   (default info; debug also logs each tool an agent uses)
//   LOG_FORMAT=pretty|json            (default pretty; json is handy for CloudWatch/grep)
//   LOG_CHANNEL=agent-logs            (optional: errors are also posted to this Slack channel; name or ID)
// On the server, systemd/journald collects stdout, so `journalctl -u agent-team` shows everything.
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const json = (process.env.LOG_FORMAT || '').toLowerCase() === 'json';
const alertChannel = (process.env.LOG_CHANNEL || '').replace(/^#/, '').trim();
const slack = alertChannel ? new WebClient(process.env.SLACK_BOT_TOKEN) : null;

// Accept a channel name ("agent-logs") or ID ("C0123ABCD"); resolve names once.
let alertChannelId;
async function resolveAlertChannel() {
  if (alertChannelId !== undefined) return alertChannelId;
  if (/^[CG][A-Z0-9]{6,}$/.test(alertChannel)) return (alertChannelId = alertChannel);
  try {
    let cursor;
    do {
      const res = await slack.conversations.list({ types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
      const hit = res.channels?.find((c) => c.name === alertChannel);
      if (hit) return (alertChannelId = hit.id);
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    console.error(`${new Date().toISOString()} WARN  LOG_CHANNEL #${alertChannel} not found; create it and /invite the bot`);
  } catch (err) {
    console.error(`${new Date().toISOString()} WARN  can't look up LOG_CHANNEL: ${err.data?.error || err.message}`);
  }
  return (alertChannelId = null);
}

function fmt(v) {
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === 'string') return /\s|"/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < min) return;
  const ts = new Date().toISOString();
  const line = json
    ? JSON.stringify({ ts, level, msg, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? v.message : v])) })
    : `${ts} ${level.toUpperCase().padEnd(5)} ${msg}` +
      Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}=${fmt(v)}`).join('');
  (LEVELS[level] >= LEVELS.warn ? console.error : console.log)(line);

  if (level === 'error' && slack) {
    const details = Object.entries(fields).map(([k, v]) => `• ${k}: \`${v instanceof Error ? v.message : String(v)}\``).join('\n');
    resolveAlertChannel()
      .then((id) => id && slack.chat.postMessage({ channel: id, text: `🚨 *${msg}*\n${details}` }))
      .catch(() => {});
  }
}

// Post a test alert so you can confirm the channel works (called once at startup).
export async function announceAlerts(text) {
  if (!slack) return;
  const id = await resolveAlertChannel();
  if (id) await slack.chat.postMessage({ channel: id, text }).catch((err) => console.error(`WARN  can't post to LOG_CHANNEL: ${err.data?.error || err.message}`));
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

// Short, single-line preview of user text for logs (never the full message).
export const preview = (text, n = 60) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Last line of defence: log crashes instead of dying silently.
process.on('unhandledRejection', (err) => write('error', 'Unhandled promise rejection', { err }));
process.on('uncaughtException', (err) => { write('error', 'Uncaught exception', { err, stack: err.stack?.split('\n')[1]?.trim() }); process.exit(1); });
