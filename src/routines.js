// Scheduled routines: multi-step jobs that run on their own, e.g.
//   08:00 every day → Remy drafts an X post → Iris sends it to Kelvin to proofread.
// Built-in routines live in DEFAULTS below; ones created from chat are saved in data/routines.json.
// Chat commands: `routines`, `run <id>`, `pause <id>`, `resume <id>`, `delete <id>`, `time <id> HH:mm`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { agents } from './agents.js';
import { getMeta, setMeta } from './threads.js';
import { getAdapter, runningPlatforms } from './platforms.js';
import { registerExecutor } from './approvals.js';
import { log } from './log.js';
import { OWNER, OWNER_BIO } from './profile.js';

const TZ = process.env.BUDGET_TZ || 'Europe/Berlin';
const FILE = path.resolve('data/routines.json');

const X_POST = `Write today's post for ${OWNER}'s X (Twitter) account.
About ${OWNER}: ${OWNER_BIO}
Rotate themes across days: a practical security tip, a building-in-public update or lesson, a developer insight,
a take on recent AI or security news (only if you're sure it's real).
Rules: max 280 characters, first person, conversational, specific, no corporate tone, at most 1 hashtag and 1 emoji.
Output only the post text, nothing else.`;

const X_DELIVER = `Remy drafted today's X post ({{previous_length}} characters):

{{previous}}

Send it to ${OWNER} to proofread: show the post exactly as written in a quote block, mention the character count,
and ask if he wants any changes. If he replies with edits, make small fixes yourself, or use ask_teammate to have
Remy rewrite it. Don't post it anywhere; ${OWNER} posts it himself.`;

export const DEFAULTS = [
  {
    id: 'x-post',
    name: 'Morning X post',
    time: process.env.X_POST_TIME || '08:00',
    days: 'daily',
    deliver: { to: 'dm' },
    steps: [
      { agent: 'writer', task: X_POST, remember: 10 },
      { agent: 'assistant', task: X_DELIVER },
    ],
  },
];

// ---------- storage ----------
let saved = { custom: [], overrides: {}, lastRun: {} };
try { saved = { ...saved, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
const save = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(saved, null, 2)); };

export function allRoutines() {
  return [...DEFAULTS.map((r) => ({ ...r, builtIn: true })), ...saved.custom]
    .map((r) => ({ enabled: true, ...r, ...(saved.overrides[r.id] || {}) }));
}
const findRoutine = (id) => allRoutines().find((r) => r.id === id);

registerExecutor('create_routine', async (r) => {
  const id = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || crypto.randomBytes(3).toString('hex');
  const unique = findRoutine(id) ? `${id}-${crypto.randomBytes(2).toString('hex')}` : id;
  saved.custom.push({ ...r, id: unique });
  save();
  return `Routine *${r.name}* (\`${unique}\`) starts at ${r.time} ${r.days === 'daily' ? 'every day' : r.days.join(', ')}. Send \`routines\` to see all, \`pause ${unique}\` to stop it.`;
});

// ---------- running ----------
const now = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, day: p.weekday.toLowerCase().slice(0, 3) };
};

function pickPlatform(r) {
  const running = runningPlatforms();
  if (r.deliver?.platform && running.includes(r.deliver.platform)) return r.deliver.platform;
  return running.includes('telegram') ? 'telegram' : running[0];
}

export async function runRoutine(r, { manual = false } = {}) {
  const { processJob } = await import('./runner.js');
  const platform = pickPlatform(r);
  if (!platform) throw new Error('no chat platform is running');
  const adapter = getAdapter(platform);
  const last = r.steps.at(-1);
  const dest = r.deliver?.to === 'here' && r.deliver.platform === platform
    ? { where: r.deliver.where, key: r.deliver.key }
    : await adapter.dmWhere(last.agent);
  const { date } = now();
  log.info('routine started', { id: r.id, platform, manual: manual || undefined });

  let previous = '';
  for (const [i, step] of r.steps.entries()) {
    const memKey = `routine-mem:${r.id}:${step.agent}`;
    let task = step.task.replaceAll('{{previous}}', previous).replaceAll('{{previous_length}}', String(previous.length));
    if (step.remember) {
      const past = getMeta(memKey) || [];
      if (past.length) task += `\n\nYour recent outputs for this routine (don't repeat their theme or opening):\n${past.map((p) => `- ${p.replace(/\n/g, ' ')}`).join('\n')}`;
    }
    const isLast = i === r.steps.length - 1;
    const job = isLast
      ? { platform, where: dest.where, key: dest.key, agent: step.agent, task, routine: r.id }
      : { platform, where: dest.where, key: `routine:${r.id}:${date}:${i}`, agent: step.agent, task, routine: r.id, silent: true };
    const out = await processJob(job);
    if (!out) throw new Error(`${agents[step.agent].name} returned nothing`);
    if (step.remember) setMeta(memKey, [...(getMeta(memKey) || []), out.slice(0, 300)].slice(-step.remember));
    previous = out.trim();
  }
  log.info('routine done', { id: r.id });
}

let timer;
export function startRoutines() {
  const tick = async () => {
    const { date, hm, day } = now();
    for (const r of allRoutines()) {
      if (!r.enabled || saved.lastRun[r.id] === date) continue;
      if (r.days !== 'daily' && !r.days.includes(day)) continue;
      // Run once the time has passed today; catch up for up to 2 hours (e.g. after a restart).
      const [h, m] = r.time.split(':').map(Number);
      const [nh, nm] = hm.split(':').map(Number);
      const late = (nh * 60 + nm) - (h * 60 + m);
      if (late < 0 || late > 120) continue;
      saved.lastRun[r.id] = date; save();
      runRoutine(r).catch((err) => log.error('routine failed', { id: r.id, err }));
    }
  };
  clearInterval(timer);
  timer = setInterval(tick, 30_000);
  tick();
  log.info('routines scheduled', { routines: allRoutines().filter((r) => r.enabled).map((r) => `${r.id}@${r.time}`).join(',') || 'none' });
}

// ---------- chat commands ----------
export async function routineCommand(text) {
  const m = text.trim().match(/^\/?(routines|run|pause|resume|delete|time)\b\s*([\w-]*)\s*(\S*)$/i);
  if (!m) return null;
  const [, cmd, id, arg] = m.map((x) => x?.toLowerCase());
  if (cmd === 'routines') {
    const rows = allRoutines().map((r) => `${r.enabled ? '🟢' : '⏸️'} \`${r.id}\` *${r.name}* · ${r.time} ${r.days === 'daily' ? 'daily' : r.days.join(',')} · ${r.steps.map((s) => agents[s.agent].name).join(' → ')} → you`);
    return `${rows.join('\n') || 'No routines yet.'}\n\nCommands: \`run <id>\` · \`pause <id>\` · \`resume <id>\` · \`time <id> 07:30\` · \`delete <id>\`. Or just ask a teammate, e.g. _"Nova, every Friday at 17:00 send me 3 security news items"_.`;
  }
  const r = findRoutine(id);
  // "run the tests" is a normal message, not a command: only answer for real routine ids (or /commands).
  if (!r) return text.trim().startsWith('/') ? `No routine \`${id || '?'}\`. Send \`routines\` to see them.` : null;
  if (cmd === 'run') { runRoutine(r, { manual: true }).catch((err) => log.error('routine failed', { id: r.id, err })); return `▶️ Running *${r.name}* now.`; }
  if (cmd === 'pause' || cmd === 'resume') { saved.overrides[r.id] = { ...saved.overrides[r.id], enabled: cmd === 'resume' }; save(); return `${cmd === 'pause' ? '⏸️ Paused' : '🟢 Resumed'} *${r.name}*.`; }
  if (cmd === 'time') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(arg)) return 'Use `time <id> HH:mm`, e.g. `time x-post 07:30`.';
    saved.overrides[r.id] = { ...saved.overrides[r.id], time: arg }; save(); return `🕗 *${r.name}* now runs at ${arg}.`;
  }
  if (cmd === 'delete') {
    if (r.builtIn) return `*${r.name}* is built in; use \`pause ${r.id}\` instead.`;
    saved.custom = saved.custom.filter((x) => x.id !== r.id); save(); return `🗑️ Deleted *${r.name}*.`;
  }
  return null;
}
