// Telegram adapter: one bot per teammate (Kai, Nova, Remy, Iris), long polling, no open ports.
//
//   TELEGRAM_OWNER_ID=123456789        your numeric Telegram user id
//   TELEGRAM_TOKEN_KAI=...             one token per teammate from @BotFather
//   TELEGRAM_TOKEN_NOVA=... TELEGRAM_TOKEN_REMY=... TELEGRAM_TOKEN_IRIS=...
//   TELEGRAM_LEAD=Remy                 (optional) the bot that reads the group; needs privacy mode OFF
//   TELEGRAM_BOT_TOKEN=...             (optional) one shared bot instead of one per teammate
//
// Groups: use a group with Topics; type /channel <name> in each topic to give it a team (channels.js).
// DMs: message a teammate's bot directly to talk to just them.
import { Bot, InputFile } from 'grammy';
import { agents, agentNames } from '../agents.js';
import { channels } from '../channels.js';
import { getThread, getMeta, setMeta } from '../threads.js';
import { handleIncoming, helpText } from '../handle.js';
import { addressed } from '../router.js';
import { spendReport } from '../spend.js';
import { registerAdapter } from '../platforms.js';
import { decide, getApproval } from '../approvals.js';
import { log, addAlertSink } from '../log.js';
import { toTelegramHtml, stripHtml, splitForTelegram } from './telegram-format.js';
import { OWNER as OWNER_NAME } from '../profile.js';

const OWNER = Number(process.env.TELEGRAM_OWNER_ID || 0);
const tokenFor = (k) => process.env[`TELEGRAM_TOKEN_${agents[k].name.toUpperCase()}`];

export const telegramEnabled = () => Boolean(OWNER && (process.env.TELEGRAM_BOT_TOKEN || agentNames.some(tokenFor)));

const bots = {};      // agentKey (or '_shared') -> Bot
const botIds = {};    // telegram user id -> agentKey
const usernames = {}; // lowercase @username -> agentKey
let lead;             // key of the bot that reads group messages

const botFor = (k) => bots[k] || bots._shared || bots[lead];
const prefixFor = (k) => (bots[k] ? '' : `${agents[k].emoji} *${agents[k].name}:* `);
const notMember = (err) => /chat not found|not a member|bot was kicked|have no rights|CHAT_WRITE_FORBIDDEN/i.test(err.description || err.message || '');

// Post as the teammate's own bot; if that bot isn't in this group, the lead bot posts with a name prefix.
async function sendAs(agentKey, chatId, text, extra) {
  try {
    return { agentKey, ids: await sendText(botFor(agentKey), chatId, prefixFor(agentKey) + text, extra) };
  } catch (err) {
    if (!notMember(err) || !bots[agentKey] || agentKey === lead) throw err;
    log.warn(`${agents[agentKey].name}'s Telegram bot isn't in this chat; add it to the group. Posting via the lead bot for now.`);
    return { agentKey: lead, ids: await sendText(bots[lead], chatId, `${agents[agentKey].emoji} *${agents[agentKey].name}:* ${text}`, extra) };
  }
}

async function sendText(bot, chatId, text, extra = {}) {
  const ids = [];
  for (const [i, chunk] of splitForTelegram(text).entries()) {
    const html = toTelegramHtml(chunk);
    const opts = { message_thread_id: extra.topicId, link_preview_options: { is_disabled: true },
      ...(i === 0 && extra.replyTo ? { reply_parameters: { message_id: extra.replyTo, allow_sending_without_reply: true } } : {}),
      ...(i === 0 && extra.reply_markup ? { reply_markup: extra.reply_markup } : {}) };
    try {
      ids.push((await bot.api.sendMessage(chatId, html, { ...opts, parse_mode: 'HTML' })).message_id);
    } catch (err) {
      if (!/parse entities|can't parse/i.test(err.description || err.message)) throw err;
      ids.push((await bot.api.sendMessage(chatId, stripHtml(html), opts)).message_id); // formatting fallback
    }
  }
  return ids;
}

async function editText(bot, chatId, messageId, text, extra = {}) {
  const html = toTelegramHtml(text);
  try {
    await bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: extra.reply_markup });
  } catch (err) {
    if (/not modified/i.test(err.description || '')) return;
    if (!/parse entities|can't parse/i.test(err.description || err.message)) throw err;
    await bot.api.editMessageText(chatId, messageId, stripHtml(html), { reply_markup: extra.reply_markup });
  }
}

const telegramAdapter = {
  target(job) {
    const { chatId, topicId, replyTo, via } = job.where;
    const created = Date.now();
    return {
      mention: '',
      post: async (agentKey, text) => {
        const r = await sendAs(agentKey, chatId, text, { topicId, replyTo });
        return { agentKey: r.agentKey, as: agentKey, id: r.ids[0] };
      },
      // Long answers: send a fresh message (which notifies) instead of silently editing "on it…".
      edit: async (handle, agentKey, text) => {
        const bot = bots[handle.agentKey] || botFor(agentKey);
        const viaLead = handle.agentKey !== agentKey && !bots._shared;
        const full = (viaLead ? `${agents[agentKey].emoji} *${agents[agentKey].name}:* ` : prefixFor(agentKey)) + text;
        if (Date.now() - created > 45_000 || splitForTelegram(full).length > 1) {
          await bot.api.deleteMessage(chatId, handle.id).catch(() => {});
          await sendText(bot, chatId, full, { topicId, replyTo });
        } else {
          await editText(bot, chatId, handle.id, full);
        }
      },
      remove: (handle) => (bots[handle.agentKey] || botFor(handle.agentKey)).api.deleteMessage(chatId, handle.id),
      sendFile: async (agentKey, filename, buf, title) => {
        const opts = { message_thread_id: topicId, caption: title !== filename ? title : undefined };
        try { await botFor(agentKey).api.sendDocument(chatId, new InputFile(buf, filename), opts); } catch (err) {
          if (!notMember(err) || agentKey === lead) throw err;
          await bots[lead].api.sendDocument(chatId, new InputFile(buf, filename), opts);
        }
      },
      askApproval: (agentKey, id, text) => sendAs(agentKey, chatId, text, {
        topicId,
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ap:${id}:y` }, { text: '❌ Cancel', callback_data: `ap:${id}:n` }]] },
      }),
      finish: () => botFor(via).api.setMessageReaction(chatId, replyTo, []).catch(() => {}),
    };
  },

  // Where a teammate DMs Kelvin (used by routines). Kelvin's replies in that DM continue the conversation.
  async dmWhere(agentKey) {
    const via = bots[agentKey] ? agentKey : lead;
    const dmAgent = via !== '_shared' ? via : undefined;
    return { where: { chatId: OWNER, via }, key: convKey(placeKey(OWNER, undefined, dmAgent)) };
  },

  // Hand-offs inside a DM go to the receiving teammate's own DM with Kelvin.
  async handoffDest(job, toAgent) {
    return job.where.chatId === OWNER && bots[toAgent] ? this.dmWhere(toAgent) : null;
  },

  async download(f) {
    if (f.size > 20 * 1024 * 1024) throw new Error('Telegram bots can only download files up to 20 MB');
    const bot = botFor(f.via);
    const file = await bot.api.getFile(f.fileId);
    const res = await fetch(`${process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org'}/file/bot${bot.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  },
};

function filesOf(msg, via) {
  const out = [];
  if (msg.document) {
    const d = msg.document;
    out.push({ name: d.file_name || 'file', filetype: (d.file_name || '').split('.').pop()?.toLowerCase(), mimetype: d.mime_type, size: d.file_size, fileId: d.file_id, via });
  }
  if (msg.photo?.length) {
    const p = msg.photo.at(-1);
    out.push({ name: `photo-${msg.message_id}.jpg`, filetype: 'jpg', mimetype: 'image/jpeg', size: p.file_size, fileId: p.file_id, via });
  }
  return out;
}

// Conversation key: per chat + topic, reset with /new.
const placeKey = (chatId, topicId, dmAgent) => (dmAgent ? `dm:${dmAgent}:${chatId}` : `${chatId}:${topicId || 0}`);
const convKey = (place) => `tg:${place}:${getMeta(`tggen:${place}`) || 0}`;

async function onMessage(ctx, receivingKey) {
  const msg = ctx.message;
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  if (msg.from?.id !== OWNER) {
    if (isPrivate) log.info('telegram message from someone other than TELEGRAM_OWNER_ID (ignored)', { from_id: msg.from?.id, username: msg.from?.username });
    return;
  }
  if (!isPrivate && receivingKey !== lead) return; // only the lead bot handles group messages

  const topicId = msg.is_topic_message ? msg.message_thread_id : undefined;
  const dmAgent = isPrivate && receivingKey !== '_shared' ? receivingKey : undefined; // DM a teammate's bot = talk to them
  const place = placeKey(chatId, topicId, dmAgent);
  let text = (msg.text || msg.caption || '').trim();
  const bot = botFor(receivingKey);
  const reply = (t) => sendText(bot, chatId, t, { topicId, replyTo: msg.message_id });

  // Commands (strip "@botname")
  const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (cmd) {
    const [, name, arg] = cmd;
    if (name === 'new') { setMeta(`tggen:${place}`, (getMeta(`tggen:${place}`) || 0) + 1); return reply('🆕 Fresh conversation. Earlier messages here are forgotten.'); }
    if (name === 'spend') return reply(spendReport());
    if (name === 'help' || name === 'start') return reply(helpText('telegram'));
    if (name === 'channel') {
      if (isPrivate) return reply('Use /channel inside a group topic.');
      const ch = arg.trim().replace(/^#/, '').toLowerCase();
      if (!ch) return reply(`This topic is ${getMeta(`tgtopic:${chatId}:${topicId || 0}`) ? `*#${getMeta(`tgtopic:${chatId}:${topicId || 0}`)}*` : 'not set'}. Options: ${Object.keys(channels).map((c) => `\`${c}\``).join(', ')}`);
      if (!channels[ch]) return reply(`No channel called \`${ch}\`. Options: ${Object.keys(channels).map((c) => `\`${c}\``).join(', ')}`);
      setMeta(`tgtopic:${chatId}:${topicId || 0}`, ch);
      return reply(`✅ This topic is now *#${ch}*: ${channels[ch].team.map((k) => agents[k].name).join(', ')}.`);
    }
    text = arg; // unknown command: treat the rest as a message
  }

  const channelName = isPrivate ? null : getMeta(`tgtopic:${chatId}:${topicId || 0}`);
  const cfg = channelName ? channels[channelName] : null;

  // Who is being addressed? Every @username mention, a reply to a teammate's message, or names in the text.
  const named = dmAgent;
  const mentioned = [];
  if (!isPrivate) {
    for (const e of msg.entities || msg.caption_entities || []) {
      if (e.type === 'mention') {
        const u = (msg.text || msg.caption).slice(e.offset + 1, e.offset + e.length).toLowerCase();
        if (usernames[u] && usernames[u] !== '_shared') { mentioned.push(usernames[u]); text = text.replace(new RegExp(`@${u}\\b`, 'i'), '').trim(); }
      }
    }
    const r = msg.reply_to_message;
    if (!mentioned.length && r && r.message_id !== msg.message_thread_id && r.from?.is_bot && botIds[r.from.id] && botIds[r.from.id] !== '_shared') mentioned.push(botIds[r.from.id]);
    // In unconfigured groups, only answer when someone is addressed.
    if (!cfg && !mentioned.length && !addressed(text) && !getThread(convKey(place))) return;
  }

  const files = filesOf(msg, receivingKey);
  await bot.api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: '👀' }]).catch(() => {});
  await handleIncoming({
    platform: 'telegram',
    key: convKey(place),
    text, files, cfg, named, mentioned,
    label: isPrivate ? `DM ${dmAgent ? agents[dmAgent].name : ''}`.trim() : `${msg.chat.title}${channelName ? ` #${channelName}` : ''}`,
    where: { chatId, topicId, replyTo: msg.message_id, via: receivingKey },
    reply: async (t) => { await reply(t); await bot.api.setMessageReaction(chatId, msg.message_id, []).catch(() => {}); },
  });
}

async function onButton(ctx) {
  const [, id, yn] = ctx.callbackQuery.data.split(':');
  if (ctx.from.id !== OWNER) return ctx.answerCallbackQuery({ text: `Only ${OWNER_NAME} can approve this.` });
  await ctx.answerCallbackQuery({ text: yn === 'y' ? 'Working on it…' : 'Cancelled' });
  const result = await decide(id, yn === 'y');
  const still = getApproval(id)?.status === 'pending';
  const original = ctx.callbackQuery.message?.text || '';
  await ctx.editMessageText(`${original}\n\n${result}`, still ? { reply_markup: ctx.callbackQuery.message.reply_markup } : {}).catch(() => {});
}

// Create the bots and register the adapter, without listening (also used by the Redis worker).
export function registerTelegramSender() {
  if (Object.keys(bots).length) return;
  const opts = process.env.TELEGRAM_API_ROOT ? { client: { apiRoot: process.env.TELEGRAM_API_ROOT } } : undefined; // for tests
  for (const k of agentNames) if (tokenFor(k)) bots[k] = new Bot(tokenFor(k), opts);
  if (process.env.TELEGRAM_BOT_TOKEN) bots._shared = new Bot(process.env.TELEGRAM_BOT_TOKEN, opts);
  const wanted = (process.env.TELEGRAM_LEAD || '').toLowerCase();
  lead = Object.keys(bots).find((k) => k !== '_shared' && agents[k].name.toLowerCase() === wanted)
    || (bots._shared ? '_shared' : Object.keys(bots)[0]);
  registerAdapter('telegram', telegramAdapter);
}

export async function startTelegram() {
  registerTelegramSender();
  // Errors are DM'd to Kelvin by the lead bot (TELEGRAM_ALERTS=false to turn off).
  if (process.env.TELEGRAM_ALERTS !== 'false') {
    addAlertSink((text) => sendText(bots[lead], OWNER, text).catch(() => {}));
  }

  const commands = [
    { command: 'help', description: 'Who is on the team' },
    { command: 'new', description: 'Start a fresh conversation here' },
    { command: 'spend', description: 'Today\'s and this month\'s costs' },
    { command: 'channel', description: 'Set this topic\'s team, e.g. /channel thesis' },
  ];

  for (const [k, bot] of Object.entries(bots)) {
    const me = await bot.api.getMe();
    botIds[me.id] = k;
    usernames[me.username.toLowerCase()] = k;
    if (k === lead && !me.can_read_all_group_messages) {
      log.warn('Telegram lead bot has privacy mode ON, so it only sees commands and @mentions in groups. In @BotFather: /setprivacy → Disable', { bot: me.username });
    }
    await bot.api.setMyCommands(commands).catch(() => {});
    bot.on('message', (ctx) => onMessage(ctx, k));
    bot.on('callback_query:data', onButton);
    bot.catch((err) => log.error('telegram error', { bot: me.username, err: err.error || err }));
    bot.start({ allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    log.info('telegram bot online', { bot: `@${me.username}`, teammate: k === '_shared' ? 'shared' : agents[k].name, lead: k === lead || undefined });
  }
}
