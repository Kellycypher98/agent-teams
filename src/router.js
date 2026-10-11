// The "manager": decides which teammate gets a message.
// Fast path: start with a name or role — "Kai, fix the login bug" / "code: …" / "hey Nova …".
// Otherwise a small model picks one.
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { agents, agentNames, findAgent } from './agents.js';

const client = new Anthropic();

// Returns the agent key if the message starts by addressing someone, else null.
export function addressed(text) {
  const m = text.match(/^\s*(?:(?:hey|hi|yo|okay|ok|thanks)\s+)?@?(\w+)\b\s*[:,\-!]?\s*/i);
  return m ? findAgent(m[1]) : null;
}

// team: optional list of agent keys to choose from (e.g. a channel's team).
export async function route(text, team = agentNames) {
  const direct = addressed(text);
  if (direct) return direct;
  if (team.length === 1) return team[0];

  const roster = team.map((n) => `- ${n} (${agents[n].name}): ${agents[n].description}`).join('\n');
  const res = await client.messages.create({
    model: process.env.ROUTER_MODEL || 'claude-haiku-5-5',
    max_tokens: 20,
    system: `Pick the single best teammate for this Slack message. Reply with only the key (e.g. "code").
Casual chat or anything unclear goes to "${team[0]}".\nTeam:\n${roster}`,
    messages: [{ role: 'user', content: text }],
  });

  const pick = res.content[0]?.text?.trim().toLowerCase();
  return team.includes(pick) ? pick : team[0];
}
