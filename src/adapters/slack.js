// Slack adapter (Socket Mode). Enabled when SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set.
import bolt from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { agents } from '../agents.js';
import { channels } from '../channels.js';
import { getThread, threadKey } from '../threads.js';
import { handleIncoming } from '../handle.js';
import { registerAdapter } from '../platforms.js';
import { decide, getApproval } from '../approvals.js';
import { log } from '../log.js';

export const slackEnabled = () => Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
const REQUIRED_SCOPES = ['channels:read', 'groups:read', 'groups:history', 'chat:write.customize', 'files:read', 'files:write'];

const web = new WebClient(process.env.SLACK_BOT_TOKEN);
let canCustomize = true;

async function postAs(agentKey, { channel, thread_ts, text, blocks }) {
  const a = agents[agentKey];
  if (canCustomize) {
    try {
      return await web.chat.postMessage({ channel, thread_ts, text, blocks, username: `${a.name} · ${a.role}`, icon_emoji: a.icon });
    } catch (err) {
      if (err.data?.error !== 'missing_scope') throw err;
      canCustomize = false;
      log.warn('Missing chat:write.customize scope; posting as the bot instead of each teammate');
    }
  }
  return web.chat.postMessage({ channel, thread_ts, text: `${a.emoji} *${a.name}:* ${text}`, blocks });
}

const slackAdapter = {
  target(job) {
    const { channel, msgTs, user } = job.where;
    let threadTs = job.where.threadTs; // undefined for a fresh DM from a routine: first post starts the thread
    return {
      mention: channel.startsWith('D') ? '' : `<@${user}> `,
      post: async (agentKey, text) => {
        const ts = (await postAs(agentKey, { channel, thread_ts: threadTs, text })).ts;
        threadTs = threadTs || ts;
        return ts;
      },
      rootKey: job.where.threadTs ? undefined : (ts) => threadKey(channel, ts),
      edit: (ts, _agentKey, text) => web.chat.update({ channel, ts, text }),
      remove: (ts) => web.chat.delete({ channel, ts }),
      sendFile: (_agentKey, filename, buf, title) =>
        web.filesUploadV2({ channel_id: channel, thread_ts: threadTs, filename, title, file: buf }),
      askApproval: (agentKey, id, text) => postAs(agentKey, {
        channel, thread_ts: threadTs, text: text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
          { type: 'actions', elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✅ Approve' }, action_id: 'approval_yes', value: id },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: '❌ Cancel' }, action_id: 'approval_no', value: id },
          ] },
        ],
      }),
      finish: () => (msgTs ? web.reactions.remove({ channel, timestamp: msgTs, name: 'eyes' }) : Promise.resolve()),
    };
  },

  // Where a teammate DMs Kelvin (used by routines). The key is set once the first message starts a thread.
  async dmWhere() {
    const { channel } = await web.conversations.open({ users: process.env.OWNER_SLACK_ID });
    return { where: { channel: channel.id, user: process.env.OWNER_SLACK_ID }, key: null };
  },

  async download(f) {
    const res = await fetch(f.url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error('Slack returned a login page; add the files:read scope and reinstall the app');
    return Buffer.from(await res.arrayBuffer());
  },
};

const slimFiles = (files = []) => files.map((f) => ({
  name: f.name || f.title || f.id, filetype: f.filetype, mimetype: f.mimetype, size: f.size, url: f.url_private_download || f.url_private,
}));

// Sending only (used by the Redis worker process).
export const registerSlackSender = () => registerAdapter('slack', slackAdapter);

export async function startSlack() {
  registerSlackSender();
  const OWNER = process.env.OWNER_SLACK_ID;
  const app = new bolt.App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
  });

  // Channel id -> name (needs channels:read / groups:read). channels.js may also use IDs.
  const names = new Map();
  let warned = false;
  async function channelConfig(id) {
    if (id.startsWith('D')) return { cfg: null, label: 'DM' };
    if (channels[id]) return { cfg: channels[id], label: id };
    if (!names.has(id)) {
      try {
        names.set(id, (await app.client.conversations.info({ channel: id })).channel?.name);
      } catch (err) {
        if (!warned) {
          warned = true;
          log.warn("can't read Slack channel name; add channels:read / groups:read and reinstall, or key channels.js by ID",
            { error: err.data?.error || err.message, needed: err.data?.needed, channel: id });
        }
        return { cfg: null, label: id };
      }
    }
    return { cfg: channels[names.get(id)] || null, label: `#${names.get(id)}` };
  }

  let botUserId;
  async function onMessage({ text = '', user, channel, ts, threadTs, files, say }) {
    if (user !== OWNER) { log.debug('ignored Slack message from non-owner', { user, channel }); return; }
    const { cfg, label } = await channelConfig(channel);
    const rootTs = threadTs || ts;
    await app.client.reactions.add({ channel, timestamp: ts, name: 'eyes' }).catch(() => {});
    await handleIncoming({
      platform: 'slack',
      key: threadKey(channel, rootTs),
      text: text.replace(/<@[^>]+>/g, '').trim(),
      files: slimFiles(files),
      cfg, label,
      where: { channel, threadTs: rootTs, msgTs: ts, user },
      reply: async (t) => { await say({ thread_ts: rootTs, text: t }); await app.client.reactions.remove({ channel, timestamp: ts, name: 'eyes' }).catch(() => {}); },
    });
  }

  app.event('app_mention', async ({ event, say }) => {
    await onMessage({ text: event.text, user: event.user, channel: event.channel, ts: event.ts, threadTs: event.thread_ts, files: event.files, say });
  });

  app.message(async ({ message, say }) => {
    if ((message.subtype && message.subtype !== 'file_share') || message.bot_id) return;
    const base = { text: message.text, user: message.user, channel: message.channel, ts: message.ts, threadTs: message.thread_ts, files: message.files, say };
    if (message.channel_type === 'im') return onMessage(base);
    if (botUserId && (message.text || '').includes(`<@${botUserId}>`)) return; // app_mention handles it
    if ((await channelConfig(message.channel)).cfg) return onMessage(base);
    if (message.thread_ts && getThread(threadKey(message.channel, message.thread_ts))) return onMessage(base);
  });

  // ✅ / ❌ buttons
  app.action(/^approval_(yes|no)$/, async ({ ack, body, action, client }) => {
    await ack();
    if (body.user?.id !== OWNER) return;
    const id = action.value;
    const result = await decide(id, action.action_id === 'approval_yes');
    const still = getApproval(id)?.status === 'pending';
    const original = body.message?.blocks?.[0];
    await client.chat.update({
      channel: body.channel.id, ts: body.message.ts, text: result,
      blocks: [original, { type: 'context', elements: [{ type: 'mrkdwn', text: result }] }, ...(still ? [body.message.blocks.at(-1)] : [])].filter(Boolean),
    }).catch((err) => log.warn('could not update approval message', { err }));
  });

  await app.start();
  const auth = await app.client.auth.test();
  botUserId = auth.user_id;
  const scopes = auth.response_metadata?.scopes || [];
  const missing = REQUIRED_SCOPES.filter((s) => scopes.length && !scopes.includes(s));
  if (missing.length) log.warn('Slack token is missing scopes; add them under OAuth & Permissions, reinstall, and update SLACK_BOT_TOKEN', { missing: missing.join(',') });
  log.info('slack online', { bot: auth.user, workspace: auth.team });
}
