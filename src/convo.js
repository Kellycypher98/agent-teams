// A short shared log per conversation, so teammates see what each other said
// (each agent's own SDK session only contains its own turns).
import { getMeta, setMeta } from './threads.js';
import { OWNER } from './profile.js';

const KEEP = 12;
const MAX_CHARS = 1500;

export function addTurn(key, who, text) {
  if (!key || !text) return;
  const k = `log:${key}`;
  const turns = getMeta(k) || [];
  turns.push({ who, text: String(text).slice(0, MAX_CHARS), at: Date.now() });
  setMeta(k, turns.slice(-KEEP));
}

/** Recent turns for an agent's prompt, only if other teammates have spoken in this conversation. */
export function recentFor(key, agentName, n = 8) {
  const turns = (getMeta(`log:${key}`) || []).slice(-n);
  if (!turns.some((t) => t.who !== `${OWNER}` && t.who !== agentName)) return '';
  return turns.map((t) => `${t.who}: ${t.text}`).join('\n\n');
}
