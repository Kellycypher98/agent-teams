// Tools that make the agents a team:
//   ask_teammate   → hand a task or question to another teammate in the same conversation;
//                    they reply there themselves (and can hand back).
//   create_routine → propose a recurring job (e.g. "every morning Remy drafts an X post and
//                    Iris sends it to Kelvin"); Kelvin approves it with a button.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agents, agentNames, findAgent } from './agents.js';
import { enqueue } from './queue.js';
import { addTurn } from './convo.js';
import { requestApproval } from './approvals.js';
import { log } from './log.js';
import { getAdapter } from './platforms.js';
import { setThread, getThread } from './threads.js';
import { OWNER } from './profile.js';

export const TEAM_TOOLS = ['mcp__team__ask_teammate', 'mcp__team__create_routine'];
const MAX_HOPS = 3; // stops teammates bouncing work back and forth forever

export function teamGuide(selfKey) {
  const others = agentNames.filter((k) => k !== selfKey).map((k) => `${agents[k].name} (${agents[k].role}: ${agents[k].description})`);
  return `You're part of a team. Teammates:\n- ${others.join('\n- ')}
Work like a team: when part of a task belongs to someone else's role, use ask_teammate to hand it over (e.g. Remy writes, then asks Iris to email it; Nova researches, then asks Remy to turn it into a post). They reply in this same conversation. Don't hand off trivial things, and don't repeat what a teammate already said.
If ${OWNER} wants something to happen regularly ("every morning", "each Friday"), use create_routine.`;
}

export function teamServer(job, selfKey, target) {
  const self = agents[selfKey];
  const names = agentNames.map((k) => agents[k].name);
  return createSdkMcpServer({
    name: 'team',
    version: '1.0.0',
    tools: [
      tool('ask_teammate',
        'Hand a task or question to a teammate. They see your message and reply in this conversation. Include everything they need (e.g. the full draft).',
        { teammate: z.string().describe(`One of: ${names.join(', ')}`), message: z.string().describe('What you need from them, with all context') },
        async ({ teammate, message }) => {
          const to = findAgent(teammate);
          if (!to) return { content: [{ type: 'text', text: `No teammate called ${teammate}. Options: ${names.join(', ')}` }], isError: true };
          if (to === selfKey) return { content: [{ type: 'text', text: "That's you." }], isError: true };
          const hops = (job.hops || 0) + 1;
          if (hops > MAX_HOPS) return { content: [{ type: 'text', text: `Too many hand-offs in a row; finish the task yourself or ask ${OWNER}.` }], isError: true };
          // Same group/thread by default; in a private chat (Telegram DM) the teammate answers in their own DM,
          // so Kelvin can reply to them there and they remember it.
          const dest = (await getAdapter(job.platform).handoffDest?.(job, to)) || { where: job.where, key: job.key };
          const sameConvo = dest.key === job.key;
          addTurn(job.key, self.name, `→ ${agents[to].name}: ${message}`);
          if (!sameConvo) {
            addTurn(dest.key, self.name, `→ ${agents[to].name}: ${message}`);
            if (!getThread(dest.key)) setThread(dest.key, { agent: to });
          }
          await enqueue({
            platform: job.platform, where: dest.where, key: dest.key, context: job.context,
            agent: to, ...(sameConvo ? { sessionKey: `${job.key}:${to}` } : {}), hops, from: selfKey,
            task: `${self.name} (${self.role}) asks you:\n\n${message}`,
          });
          log.info('handoff', { from: self.name, to: agents[to].name, hops, thread: job.key });
          return { content: [{ type: 'text', text: `Sent to ${agents[to].name}; they'll reply in this conversation. Tell ${OWNER} briefly that you've passed it on.` }] };
        }),

      tool('create_routine',
        `Propose a recurring routine. ${OWNER} approves it with a button before it starts.`,
        {
          name: z.string().describe('Short name, e.g. "Morning X post"'),
          time: z.string().describe('Local time HH:mm (Europe/Berlin), e.g. "08:00"'),
          days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional().describe('Omit for every day'),
          steps: z.array(z.object({
            teammate: z.string(),
            task: z.string().describe('Instructions. In later steps, {{previous}} is replaced with the previous step\'s output.'),
          })).min(1).max(4).describe(`Run in order; only the last step messages ${OWNER}`),
          deliver: z.enum(['dm', 'here']).default('dm').describe(`dm = last teammate DMs ${OWNER}; here = post in this conversation`),
        },
        async ({ name, time, days, steps, deliver }) => {
          try {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('time must be HH:mm');
            const mapped = steps.map((s) => {
              const k = findAgent(s.teammate);
              if (!k) throw new Error(`unknown teammate ${s.teammate}`);
              return { agent: k, task: s.task };
            });
            const routine = { name, time, days: days?.length ? days : 'daily', steps: mapped,
              deliver: deliver === 'here' ? { to: 'here', platform: job.platform, where: job.where, key: job.key } : { to: 'dm', platform: job.platform } };
            const preview = [`*Start routine "${name}"?*`, `🕗 ${time} ${days?.length ? days.join(', ') : 'every day'}`,
              ...mapped.map((s, i) => `${i + 1}. *${agents[s.agent].name}:* ${s.task.slice(0, 200)}`),
              deliver === 'here' ? '📍 Posts in this conversation' : `📬 ${agents[mapped.at(-1).agent].name} sends the result to you directly`].join('\n');
            await requestApproval(target, selfKey, 'create_routine', routine, preview);
            return { content: [{ type: 'text', text: `Proposed; waiting for ${OWNER} to approve.` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        }),
    ],
  });
}
