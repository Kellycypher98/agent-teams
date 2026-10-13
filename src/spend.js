// Tracks what the team spends per day, and enforces DAILY_BUDGET_USD.
//   DAILY_BUDGET_USD=3      stop taking new work once today's spend reaches this (0 = no limit)
//   BUDGET_TZ=Europe/Berlin which midnight "today" resets at
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/spend.json');
const TZ = process.env.BUDGET_TZ || 'Europe/Berlin';
export const DAILY_BUDGET = Number(process.env.DAILY_BUDGET_USD) || 0;

let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }

const day = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

function save() {
  // keep ~90 days
  const keys = Object.keys(data).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete data[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function addSpend(usd, agentName) {
  if (!(usd > 0)) return;
  const d = day();
  data[d] ??= { total: 0, jobs: 0, byAgent: {} };
  data[d].total += usd;
  data[d].jobs += 1;
  data[d].byAgent[agentName] = (data[d].byAgent[agentName] || 0) + usd;
  save();
}

export const spentToday = () => data[day()]?.total || 0;
export const overBudget = () => DAILY_BUDGET > 0 && spentToday() >= DAILY_BUDGET;

export function spendReport() {
  const today = data[day()] || { total: 0, jobs: 0, byAgent: {} };
  const week = Object.entries(data)
    .filter(([d]) => d > day(new Date(Date.now() - 7 * 864e5)))
    .reduce((s, [, v]) => s + v.total, 0);
  const month = Object.entries(data)
    .filter(([d]) => d.slice(0, 7) === day().slice(0, 7))
    .reduce((s, [, v]) => s + v.total, 0);
  const who = Object.entries(today.byAgent).sort((a, b) => b[1] - a[1])
    .map(([n, v]) => `${n} $${v.toFixed(2)}`).join(' · ') || 'nobody yet';
  const cap = DAILY_BUDGET > 0 ? ` of $${DAILY_BUDGET.toFixed(2)} daily budget` : ' (no daily limit set)';
  return [
    `*Today:* $${today.total.toFixed(2)}${cap} · ${today.jobs} replies`,
    `*By teammate:* ${who}`,
    `*Last 7 days:* $${week.toFixed(2)} · *This month:* $${month.toFixed(2)}`,
    '_Estimates from the Agent SDK; your Anthropic console has the exact bill._',
  ].join('\n');
}
