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
  let res;
  try {
    res = await client.messages.create({
    model: process.env.ROUTER_MODEL || 'claude-haiku-5-5',
    max_tokens: 20,
    system: `Pick the single best teammate for this chat message. Reply with only the key (e.g. "code").
Casual chat or anything unclear goes to "${team[0]}".\nTeam:\n${roster}`,
    messages: [{ role: 'user', content: text }],
    });
  } catch {
    return team[0]; // router unavailable: use the channel's default teammate
  }

  const pick = res.content[0]?.text?.trim().toLowerCase();
  return team.includes(pick) ? pick : team[0];
}

// For team channels: which teammates have something useful to add? (1 to all of them)
export async function pickTeam(text, team) {
  if (/\b(everyone|everybody|all of you|team|guys|y'?all)\b/i.test(text)) return team;
  const roster = team.map((n) => `- ${n} (${agents[n].name}): ${agents[n].description}`).join('\n');
  try {
    const res = await client.messages.create({
      model: process.env.ROUTER_MODEL || 'claude-haiku-5-5',
      max_tokens: 30,
      system: `Decide which teammates should reply to this message in a team standup. Include only those whose role clearly adds something; one is often enough.
Reply with the keys, comma-separated, nothing else.\nTeam:\n${roster}`,
      messages: [{ role: 'user', content: text }],
    });
    const picks = (res.content[0]?.text || '').toLowerCase().split(/[\s,]+/).filter((k) => team.includes(k));
    return picks.length ? [...new Set(picks)] : team;
  } catch {
    return team; // if picking fails, everyone answers rather than one arbitrary teammate
  }
}

// All teammates addressed at the start of a message: "Kai and Nova, …", "Remy, Iris: …", "@kai @nova …".
export function addressedAll(text) {
  const found = [];
  let rest = String(text || '').trim().replace(/^(?:hey|hi|yo|okay|ok|thanks)\s+/i, '');
  for (;;) {
    const m = rest.match(/^@?(\w+)\s*(?:,|&|\+|\/|\band\b|:)?\s*/i);
    const key = m && findAgent(m[1]);
    if (!key) break;
    if (!found.includes(key)) found.push(key);
    rest = rest.slice(m[0].length);
  }
  return found;
}
