// Slack front door. Talk to your team like coworkers:
//  - DM the bot, or @mention it in a channel.
//  - Address someone by name ("Kai, …", "hey Nova …") or let the manager pick.
//  - Reply in the thread to keep talking to the same teammate; they remember the thread.
//  - Name someone else mid-thread to hand the conversation over.
//  - Team channels (src/channels.js) have default teammates and need no @mention.
import 'dotenv/config';
import bolt from '@slack/bolt';
import { route, addressed } from './router.js';
import { enqueue, useRedis } from './queue.js';
import { agents, agentNames } from './agents.js';
import { getThread, setThread, threadKey } from './threads.js';
import { channels } from './channels.js';
import { log, preview, announceAlerts } from './log.js';
import { slimFiles } from './files.js';

// Channel lookup. channels.js can be keyed by channel ID (no extra scope needed)
// or by name (needs the channels:read scope).
const channelNames = new Map();
let warnedScope = false;
async function channelConfig(channelId) {
  if (channelId.startsWith('D')) return null; // DMs
  if (channels[channelId]) return channels[channelId];
  if (!channelNames.has(channelId)) {
    try {
      const info = await app.client.conversations.info({ channel: channelId });
      channelNames.set(channelId, info.channel?.name);
    } catch (err) {
      if (!warnedScope) {
        warnedScope = true;
        const d = err.data || {};
        log.warn("can't read channel name; add channels:read (public) / groups:read (private) and reinstall, or key channels.js by ID",
          { error: d.error || err.message, needed: d.needed, channel: channelId });
      }
      return null; // not cached, so it works as soon as the scope is fixed
    }
  }
  return channels[channelNames.get(channelId)] || null;
}

const { App } = bolt;
const OWNER = process.env.OWNER_SLACK_ID;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

let botUserId;

async function handle({ text, user, channel, ts, threadTs, say, files = [] }) {
  if (user !== OWNER) { log.debug('ignored message from non-owner', { user, channel }); return; } // only you can give orders
  let clean = text.replace(/<@[^>]+>/g, '').trim();
  if (!clean && files.length) clean = files.length === 1 ? 'Have a look at this file.' : 'Have a look at these files.';
  if (!clean) return;

  const rootTs = threadTs || ts;
  const key = threadKey(channel, rootTs);

  if (/^(help|team|agents|who'?s here\??)$/i.test(clean)) {
    const lines = agentNames.map((k) => `${agents[k].emoji} *${agents[k].name}* (${agents[k].role}) — ${agents[k].description}`);
    await say({
      thread_ts: rootTs,
      text: `Your team:\n${lines.join('\n')}\n\nJust talk normally — e.g. _"Kai, can you look at the login bug?"_. Reply in the thread to keep chatting with the same person. In #standup everyone answers unless you name someone.`,
    });
    return;
  }

  const cfg = await channelConfig(channel);
  const existing = getThread(key);
  const named = addressed(clean);
  const chan = channelNames.get(channel) || channel;
  await app.client.reactions.add({ channel, timestamp: ts, name: 'eyes' }).catch(() => {});
  const job = { task: clean, channel, threadTs: rootTs, msgTs: ts, user, key, context: cfg?.context, files: slimFiles(files) };

  // Team channels (mode 'all'): everyone replies unless you name someone. Each teammate keeps
  // their own memory of the thread.
  if (cfg?.mode === 'all') {
    const who = named ? [named] : cfg.team;
    if (!existing) setThread(key, { mode: 'all' });
    log.info('message', { channel: chan, agents: who.map((k) => agents[k].name).join(','), routedBy: named ? 'name' : 'team',
      thread: key, newThread: !existing, text: preview(clean), files: files.length || undefined });
    for (const agent of who) await enqueue({ ...job, agent, sessionKey: `${key}:${agent}` });
    return;
  }

  // Otherwise one teammate per thread: stay with them unless you name someone else.
  const agent = named || existing?.agent || (await route(clean, cfg?.team));
  const routedBy = named ? 'name' : existing?.agent ? 'thread' : (cfg?.team?.length === 1 ? 'channel' : 'router');
  log.info('message', {
    channel: chan, agent: agents[agent].name, routedBy,
    thread: key, newThread: !existing, text: preview(clean), files: files.length || undefined,
  });
  if (!existing || existing.agent !== agent) setThread(key, { agent, sessionId: existing?.agent === agent ? existing.sessionId : undefined });
  await enqueue({ ...job, agent });
}

// @mentions in channels
app.event('app_mention', async ({ event, say }) => {
  await handle({ text: event.text, user: event.user, channel: event.channel, ts: event.ts, threadTs: event.thread_ts, say, files: event.files });
});

// DMs, plus replies in channel threads a teammate is already part of (no @mention needed)
app.message(async ({ message, say }) => {
  // Allow normal messages and messages with attached files; skip edits, joins, bot posts, etc.
  if ((message.subtype && message.subtype !== 'file_share') || message.bot_id) return;
  const text = message.text || '';
  const base = { text, user: message.user, channel: message.channel, ts: message.ts, threadTs: message.thread_ts, say, files: message.files };

  if (message.channel_type === 'im') return handle(base);

  const mentionsBot = botUserId && text.includes(`<@${botUserId}>`);
  if (mentionsBot) return; // app_mention handles those

  // Team channels (listed in channels.js): every message counts.
  if (await channelConfig(message.channel)) return handle(base);

  // Other channels: only replies in threads a teammate is already in.
  const inActiveThread = message.thread_ts && getThread(threadKey(message.channel, message.thread_ts));
  if (inActiveThread) return handle(base);
});

await app.start();
const auth = await app.client.auth.test();
botUserId = auth.user_id;
const scopes = auth.response_metadata?.scopes || [];
const missing = ['channels:read', 'groups:read', 'groups:history', 'chat:write.customize', 'files:read'].filter((s) => scopes.length && !scopes.includes(s));
if (missing.length) log.warn('bot token is missing scopes; add them under OAuth & Permissions, reinstall, and update SLACK_BOT_TOKEN', { missing: missing.join(',') });
await announceAlerts(`🟢 Team online · ${agentNames.map((k) => agents[k].name).join(', ')} · errors will be posted here`);
log.info('team online', { bot: auth.user, workspace: auth.team, queue: useRedis ? 'redis' : 'built-in', agents: agentNames.map((k) => agents[k].name).join(',') });
