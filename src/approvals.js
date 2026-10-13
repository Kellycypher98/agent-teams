// Human-in-the-loop approvals. Risky actions (sending email, creating calendar events) are never
// done by an agent directly: the tool saves the action here and posts ✅/❌ buttons. The action
// only runs when Kelvin taps ✅, and it runs exactly as previewed, so an agent (or a malicious
// email it read) can't change it afterwards.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.js';

const FILE = path.resolve('data/approvals.json');
const TTL_MS = 48 * 3600 * 1000; // buttons expire after 2 days

let store = {};
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { store = {}; }

function save() {
  for (const [id, a] of Object.entries(store)) if (Date.now() - a.createdAt > 14 * 864e5) delete store[id];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

const executors = {};
/** Register what an approved action of this kind does: async (params) => resultText */
export function registerExecutor(kind, fn) {
  executors[kind] = fn;
}

/** Save an action and ask Kelvin. Returns the approval id. */
export async function requestApproval(target, agentKey, kind, params, preview) {
  if (!executors[kind]) throw new Error(`no executor for ${kind}`);
  const id = crypto.randomBytes(6).toString('hex');
  store[id] = { id, kind, params, agent: agentKey, status: 'pending', createdAt: Date.now() };
  save();
  await target.askApproval(agentKey, id, preview);
  log.info('approval requested', { id, kind, agent: agentKey });
  return id;
}

/**
 * Called by an adapter when Kelvin taps a button.
 * Returns the text to show in place of the buttons.
 */
export async function decide(id, approve) {
  const a = store[id];
  if (!a) return '⚠️ This request no longer exists.';
  if (a.status !== 'pending') return `Already ${a.status}.`;
  if (Date.now() - a.createdAt > TTL_MS) {
    a.status = 'expired'; save();
    return '⌛ This request expired. Ask again if you still want it.';
  }
  if (!approve) {
    a.status = 'cancelled'; a.decidedAt = Date.now(); save();
    log.info('approval cancelled', { id, kind: a.kind });
    return '❌ Cancelled. Nothing was sent.';
  }
  a.status = 'running'; save();
  try {
    const result = await executors[a.kind](a.params);
    a.status = 'done'; a.decidedAt = Date.now(); save();
    log.info('approval executed', { id, kind: a.kind });
    return `✅ ${result}`;
  } catch (err) {
    a.status = 'pending'; save(); // let Kelvin retry
    log.error('approved action failed', { id, kind: a.kind, err });
    return `⚠️ Failed: ${err.message}. Tap ✅ again to retry.`;
  }
}

export const getApproval = (id) => store[id];
