// Platform-agnostic handling of a message from Kelvin: commands, picking teammates, queueing.
// Adapters (Slack, Telegram) call handleIncoming() after their own owner check.
import { route, addressed, addressedAll, pickTeam } from './router.js';
import { enqueue } from './queue.js';
import { agents, agentNames } from './agents.js';
import { getThread, setThread } from './threads.js';
import { log, preview } from './log.js';
import { spendReport } from './spend.js';
import { integrationStatus } from './integrations/index.js';
import { addTurn } from './convo.js';
import { routineCommand } from './routines.js';
import { OWNER } from './profile.js';

const EVERYONE = /\b(everyone|everybody|all of you|team|y'?all)\b/i;

export function helpText(platform) {
  const lines = agentNames.map((k) => `${agents[k].emoji} *${agents[k].name}* (${agents[k].role}) — ${agents[k].description}`);
  const tips = platform === 'telegram'
    ? 'Talk normally, e.g. _"Kai, can you look at the login bug?"_ or reply to a teammate\'s message. /new starts a fresh conversation, /spend shows costs, /channel <name> sets this topic\'s team.'
    : 'Talk normally, e.g. _"Kai, can you look at the login bug?"_. Reply in the thread to keep chatting. Send `spend` to see costs.';
  return `Your team:\n${lines.join('\n')}\n\n${tips}\n\n${integrationStatus()}`;
}

/**
 * msg = {
 *   platform: 'slack' | 'telegram',
 *   key:      conversation key (see threads.js),
 *   text, files,            // files already slimmed by the adapter
 *   cfg,                    // channel config from channels.js (or null)
 *   label,                  // human name of the place, for logs
 *   named,                  // teammate chosen by the platform (e.g. Telegram DM to Kai's bot)
 *   mentioned,              // teammates @mentioned / replied to (Telegram), merged with names in the text
 *   where,                  // platform data the adapter needs to reply (serialisable)
 *   reply(text),            // quick reply for commands
 * }
 */
export async function handleIncoming(msg) {
  const { platform, key, cfg, files = [] } = msg;
  let text = (msg.text || '').trim();
  if (!text && files.length) text = files.length === 1 ? 'Have a look at this file.' : 'Have a look at these files.';
  if (!text) return;

  if (/^\/?(spend|cost|costs|budget)\??$/i.test(text)) return msg.reply(spendReport());
  if (/^\/?(help|team|agents|start|who'?s here\??)$/i.test(text)) return msg.reply(helpText(platform));
  const routineReply = await routineCommand(text);
  if (routineReply) return msg.reply(routineReply);

  const existing = getThread(key);
  const job = { platform, where: msg.where, key, task: text, context: cfg?.context, files };
  addTurn(key, `${OWNER}`, text);

  // Several teammates addressed at once ("Kai and Nova, …", "@kai @nova"): each one replies,
  // and follow-ups in this conversation keep going to the same group.
  const names = msg.named ? [msg.named] : [...new Set([...(msg.mentioned || []), ...addressedAll(text)])];
  const group = names.length > 1 ? names : (!names.length && existing?.mode === 'multi' ? existing.who : null);
  if (group) {
    setThread(key, { mode: 'multi', who: group });
    log.info('message', { platform, place: msg.label, agents: group.map((k) => agents[k].name).join(','),
      routedBy: names.length > 1 ? 'names' : 'group', thread: key, newThread: !existing, text: preview(text), files: files.length || undefined });
    for (const agent of group) await enqueue({ ...job, agent, sessionKey: `${key}:${agent}` });
    return;
  }
  const named = names[0] || addressed(text);

  // Team channels: 'all' = everyone replies, 'relevant' = only those with something to add.
  // Naming someone always wins. Each teammate keeps their own memory of the conversation.
  if (!msg.named && (cfg?.mode === 'all' || cfg?.mode === 'relevant')) {
    let who;
    if (named) who = [named];
    else if (cfg.mode === 'all' || EVERYONE.test(text)) who = cfg.team;
    else if (existing?.who?.length) who = existing.who;
    else who = await pickTeam(text, cfg.team);
    setThread(key, { mode: cfg.mode, who: [...new Set([...(existing?.who || []), ...who])] });
    log.info('message', { platform, place: msg.label, agents: who.map((k) => agents[k].name).join(','),
      routedBy: named ? 'name' : cfg.mode, thread: key, newThread: !existing, text: preview(text), files: files.length || undefined });
    // Group replies (not a named request) can use a cheaper model and stay short.
    const groupReply = !named && cfg.replyModel ? { model: cfg.replyModel, brief: true } : {};
    for (const agent of who) await enqueue({ ...job, ...groupReply, agent, sessionKey: `${key}:${agent}` });
    return;
  }

  // One teammate per conversation: stay with them unless Kelvin names someone else.
  const agent = named || existing?.agent || (await route(text, cfg?.team));
  const routedBy = msg.named ? 'direct' : named ? 'name' : existing?.agent ? 'thread' : (cfg?.team?.length === 1 ? 'channel' : 'router');
  log.info('message', { platform, place: msg.label, agent: agents[agent].name, routedBy,
    thread: key, newThread: !existing, text: preview(text), files: files.length || undefined });
  if (existing?.who?.length) {
    // In a group conversation, talking to one teammate keeps everyone's separate memory intact.
    await enqueue({ ...job, agent, sessionKey: `${key}:${agent}` });
    return;
  }
  if (!existing || existing.agent !== agent) setThread(key, { agent, sessionId: existing?.agent === agent ? existing.sessionId : undefined });
  await enqueue({ ...job, agent });
}
