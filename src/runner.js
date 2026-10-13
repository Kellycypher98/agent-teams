// Runs one message through a teammate with the Claude Agent SDK and replies on whichever
// platform it came from (Slack or Telegram), as that teammate.
import 'dotenv/config';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { agents } from './agents.js';
import { getThread, setThread } from './threads.js';
import { log } from './log.js';
import { prepareFiles } from './files.js';
import { addSpend, overBudget, spentToday, DAILY_BUDGET } from './spend.js';
import { outboxServer, OUTBOX_TOOLS, DEFAULT_TZ } from './outbox.js';
import { mailServer, MAIL_TOOLS, integrationsReady } from './integrations/index.js';
import { getAdapter } from './platforms.js';
import { teamServer, TEAM_TOOLS, teamGuide } from './teamtools.js';
import { addTurn, recentFor } from './convo.js';
import { OWNER } from './profile.js';

const OUTBOX_GUIDE = `You can send files into this conversation:
- create_calendar_file: an .ics file for meetings, deadlines, schedules or study plans. Use local times in ${DEFAULT_TZ} unless told otherwise; add a reminder when it helps.
- share_file: for CSVs, Markdown notes, code snippets or anything ${OWNER} should download.
After sending a file, just say what's in it in a line or two.`;

const BRIEF = 'This is a group message where several teammates reply. Answer in 2-4 short lines from your own role only, or reply with just "—" if you have nothing useful to add.';

const nowLine = () => new Date().toLocaleString('en-GB', {
  timeZone: DEFAULT_TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
}) + ` (${DEFAULT_TZ})`;

async function runAgent(job, target, adapter) {
  const { agent, task, key, sessionKey, context, files } = job;
  const sKey = sessionKey || key;
  const a = agents[agent];
  const model = job.model || a.model;
  fs.mkdirSync(a.cwd, { recursive: true });

  const prev = getThread(sKey);
  const resume = prev?.agent === agent ? prev.sessionId : undefined;

  let result = '';
  let cost = 0;
  let sessionId;
  let turns = 0;
  let costTotal = 0;
  const toolsUsed = {};
  log.info('job started', { platform: job.platform, agent: a.name, model, thread: key, resume: Boolean(resume), files: files?.length || undefined });

  // Shared files become content blocks (PDF/image natively, docs as text).
  const { blocks, notes } = await prepareFiles(files, key, (f) => adapter.download(f));
  const text = notes.length ? `${task}\n\nAttached files:\n${notes.join('\n')}` : task;
  const prompt = blocks.length
    ? (async function* () {
        yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }, ...blocks] }, parent_tool_use_id: null };
      })()
    : text;

  const mcpServers = { files: outboxServer(target, agent), team: teamServer(job, agent, target) };
  const allowed = [...a.tools, ...OUTBOX_TOOLS, ...TEAM_TOOLS];
  if (a.integrations) {
    mcpServers.mail = mailServer(target, agent);
    allowed.push(...MAIL_TOOLS);
  }

  const shared = job.silent ? '' : recentFor(key, a.name);
  const systemPrompt = [
    a.prompt,
    teamGuide(agent),
    OUTBOX_GUIDE,
    shared && `Recent messages in this conversation (from ${OWNER} and your teammates; newest last):\n${shared}`,
    job.silent && `Your output goes straight to a teammate, not to ${OWNER}. Output only what was asked.`,
    a.integrations && !integrationsReady() && `No email or calendar accounts are connected yet. If asked, tell ${OWNER} to run \`npm run auth:google\` / \`npm run auth:microsoft\` (see README).`,
    job.brief && BRIEF,
    `Now: ${nowLine()}.`,
    `You're talking on ${job.platform === 'telegram' ? 'Telegram' : 'Slack'}.`,
    context && `Channel context: ${context}`,
  ].filter(Boolean).join('\n\n');

  for await (const msg of query({
    prompt,
    options: {
      model,
      maxBudgetUsd: a.maxUsd,      // hard stop for one runaway task
      systemPrompt,
      cwd: a.cwd,
      mcpServers,
      allowedTools: allowed,
      tools: a.tools,              // only these built-in tools exist for this teammate
      permissionMode: 'dontAsk',   // unattended: anything not allowed is refused, not prompted
      maxTurns: a.maxTurns,
      ...(resume && { resume }),   // continue this conversation
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
      result = msg.subtype === 'success' ? msg.result
        : msg.subtype === 'error_max_budget_usd' ? `I stopped because this task reached its $${a.maxUsd.toFixed(2)} limit. Reply *keep going* if you want me to continue.`
        : msg.subtype === 'error_max_turns' ? 'I ran out of steps on this one. Reply *keep going* to let me continue, or narrow it down.'
        : `Hit a wall (${msg.subtype}). Want me to try again?`;
      // A resumed session reports the conversation's running total, so subtract earlier messages.
      const total = msg.total_cost_usd ?? 0;
      cost = Math.max(0, total - (resume ? prev?.costTotal || 0 : 0));
      costTotal = total;
      turns = msg.num_turns ?? 0;
      if (msg.subtype !== 'success') log.warn('agent stopped early', { agent: a.name, reason: msg.subtype, thread: key });
      if (msg.permission_denials?.length) {
        log.warn('tools refused', { agent: a.name, tools: [...new Set(msg.permission_denials.map((d) => d.tool_name))].join(','), thread: key });
      }
    }
  }

  if (sessionId) setThread(sKey, { agent, sessionId, costTotal });
  addSpend(cost, a.name);
  return { result, cost, turns, toolsUsed };
}

// One message at a time per conversation (per teammate), so replies stay in order.
const locks = new Map();

export function processJob(job) {
  const lockKey = job.sessionKey || job.key;
  const prev = locks.get(lockKey) || Promise.resolve();
  const next = prev.then(() => handleJob(job));
  locks.set(lockKey, next.catch(() => {}));
  return next;
}

async function handleJob(job) {
  const { agent } = job;
  const adapter = getAdapter(job.platform);
  const target = adapter.target(job);
  const started = Date.now();

  // Behind-the-scenes step (e.g. Remy drafting for Iris in a routine): run and return the text.
  if (job.silent) {
    if (overBudget()) throw new Error('daily budget reached');
    const { result, cost } = await runAgent(job, target, adapter);
    log.info('job done', { agent: agents[agent].name, silent: true, secs: Number(((Date.now() - started) / 1000).toFixed(1)), cost: `$${cost.toFixed(3)}`, thread: job.key });
    return result;
  }

  if (overBudget()) {
    log.warn('daily budget reached; job skipped', { agent: agents[agent].name, spent: `$${spentToday().toFixed(2)}`, budget: `$${DAILY_BUDGET}` });
    await target.post(agent, `We've hit today's $${DAILY_BUDGET.toFixed(2)} budget ($${spentToday().toFixed(2)} spent), so I'm pausing until tomorrow. Raise \`DAILY_BUDGET_USD\` if this is urgent.`).catch(() => {});
    await target.finish().catch(() => {});
    return;
  }

  // Instant "on it" so Kelvin isn't left waiting; replaced by the real answer.
  const placeholder = await target.post(agent, '_on it…_').catch(() => null);
  // A new Slack DM from a routine starts its own thread: use it as the conversation key.
  if (!job.key && placeholder && target.rootKey) job.key = target.rootKey(placeholder);
  try {
    const { result, cost, turns, toolsUsed } = await runAgent(job, target, adapter);
    const quiet = job.brief && /^[\s—–-]*$/.test(result); // group reply with nothing to add
    if (!quiet) addTurn(job.key, agents[agent].name, result);
    const costNote = cost >= 0.05 ? `\n_cost: $${cost.toFixed(2)}_` : '';
    const text = `${target.mention}${result}${costNote}`;
    if (quiet) {
      if (placeholder) await target.remove(placeholder).catch(() => {});
    } else if (placeholder) {
      await target.edit(placeholder, agent, text);
      // Edits don't notify; ping in group chats when it took a while.
      if (target.mention && Date.now() - started > 60_000) await target.post(agent, `${target.mention}done ☝️`);
    } else {
      await target.post(agent, text);
    }
    log.info('job done', {
      platform: job.platform,
      agent: agents[agent].name,
      secs: Number(((Date.now() - started) / 1000).toFixed(1)),
      cost: `$${cost.toFixed(3)}`,
      turns,
      tools: Object.entries(toolsUsed).map(([t, n]) => `${t}x${n}`).join(',') || 'none',
      thread: job.key,
      skipped: quiet || undefined,
    });
    await target.finish().catch(() => {});
    return result;
  } catch (err) {
    log.error('job failed', { platform: job.platform, agent: agents[agent].name, thread: job.key, err, secs: Number(((Date.now() - started) / 1000).toFixed(1)) });
    const msg = `${target.mention}something broke on my side: \`${err.message}\``;
    await (placeholder ? target.edit(placeholder, agent, msg) : target.post(agent, msg)).catch(() => {});
  }
}
