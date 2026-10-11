// Runs one message through a teammate with the Claude Agent SDK and replies in Slack
// under that teammate's own name and avatar.
import 'dotenv/config';
import fs from 'node:fs';
import { WebClient } from '@slack/web-api';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { agents } from './agents.js';
import { getThread, setThread } from './threads.js';
import { log } from './log.js';
import { prepareFiles } from './files.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
let canCustomize = true; // turns off if the app lacks chat:write.customize

async function postAs(agentKey, { channel, thread_ts, text }) {
  const a = agents[agentKey];
  if (canCustomize) {
    try {
      return await slack.chat.postMessage({
        channel, thread_ts, text,
        username: `${a.name} · ${a.role}`,
        icon_emoji: a.icon,
      });
    } catch (err) {
      if (err.data?.error !== 'missing_scope') throw err;
      canCustomize = false;
      log.warn('Missing chat:write.customize scope; posting as the bot instead of each teammate');
    }
  }
  return slack.chat.postMessage({ channel, thread_ts, text: `${a.emoji} *${a.name}:* ${text}` });
}

async function runAgent({ agent, task, key, context, files }) {
  const a = agents[agent];
  fs.mkdirSync(a.cwd, { recursive: true });

  const prev = getThread(key);
  const resume = prev?.agent === agent ? prev.sessionId : undefined;

  let result = '';
  let cost = 0;
  let sessionId;
  let turns = 0;
  const toolsUsed = {};
  log.info('job started', { agent: a.name, thread: key, resume: Boolean(resume), files: files?.length || undefined });

  // Files shared in Slack become content blocks (PDF/image natively, docs as text).
  const { blocks, notes } = await prepareFiles(files, key);
  const text = notes.length ? `${task}\n\nAttached files:\n${notes.join('\n')}` : task;
  const prompt = blocks.length
    ? (async function* () {
        yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }, ...blocks] }, parent_tool_use_id: null };
      })()
    : text;

  for await (const msg of query({
    prompt,
    options: {
      model: process.env.AGENT_MODEL || 'claude-sonnet-5-5',
      systemPrompt: context ? `${a.prompt}\n\nChannel context: ${context}` : a.prompt,
      cwd: a.cwd,
      allowedTools: a.tools,
      tools: a.tools,              // only these tools exist for this teammate
      permissionMode: 'dontAsk',   // unattended: anything not allowed is refused, not prompted
      maxTurns: a.maxTurns,
      ...(resume && { resume }),   // continue this thread's conversation
    },
  })) {
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_use') continue;
        toolsUsed[block.name] = (toolsUsed[block.name] || 0) + 1;
        log.debug('tool', { agent: a.name, tool: block.name, thread: key });
      }
    }
    if (msg.type === 'result') {
      result = msg.subtype === 'success' ? msg.result : `Hit a wall (${msg.subtype}). Want me to keep going?`;
      cost = msg.total_cost_usd ?? 0;
      turns = msg.num_turns ?? 0;
      if (msg.subtype !== 'success') log.warn('agent stopped early', { agent: a.name, reason: msg.subtype, thread: key });
      if (msg.permission_denials?.length) {
        log.warn('tools refused', { agent: a.name, tools: [...new Set(msg.permission_denials.map((d) => d.tool_name))].join(','), thread: key });
      }
    }
  }

  if (sessionId) setThread(key, { agent, sessionId });
  return { result, cost, turns, toolsUsed };
}

// One message at a time per thread, so a conversation stays in order.
const threadLocks = new Map();

export function processJob(data) {
  const prev = threadLocks.get(data.key) || Promise.resolve();
  const next = prev.then(() => handleJob(data));
  threadLocks.set(data.key, next.catch(() => {}));
  return next;
}

async function handleJob(data) {
  const { agent, channel, threadTs, msgTs, user } = data;
  const isDM = channel.startsWith('D');
  const started = Date.now();
  // Instant "on it" so you're not left waiting; replaced by the real answer.
  const placeholder = await postAs(agent, { channel, thread_ts: threadTs, text: '_on it…_' }).catch(() => null);
  try {
    const { result, cost, turns, toolsUsed } = await runAgent(data);
    const mention = isDM ? '' : `<@${user}> `;
    const costNote = cost >= 0.05 ? `\n_cost: $${cost.toFixed(2)}_` : '';
    const text = `${mention}${result}${costNote}`;
    if (placeholder?.ts) {
      await slack.chat.update({ channel, ts: placeholder.ts, text });
      // Edits don't notify; ping in channels so you know it's done.
      if (!isDM && Date.now() - started > 60_000) await postAs(agent, { channel, thread_ts: threadTs, text: `<@${user}> done ☝️` });
    } else {
      await postAs(agent, { channel, thread_ts: threadTs, text });
    }
    log.info('job done', {
      agent: agents[agent].name,
      secs: Number(((Date.now() - started) / 1000).toFixed(1)),
      cost: `$${cost.toFixed(3)}`,
      turns,
      tools: Object.entries(toolsUsed).map(([t, n]) => `${t}x${n}`).join(',') || 'none',
      thread: data.key,
    });
    await slack.reactions.remove({ channel, timestamp: msgTs, name: 'eyes' }).catch(() => {});
  } catch (err) {
    log.error('job failed', { agent: agents[agent].name, thread: data.key, err, secs: Number(((Date.now() - started) / 1000).toFixed(1)) });
    await postAs(agent, { channel, thread_ts: threadTs, text: `<@${user}> something broke on my side: \`${err.message}\`` }).catch(() => {});
  }
}
