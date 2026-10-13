// Remembers who owns each conversation and their Agent SDK session, so follow-ups continue
// the same conversation (even after a restart). Keys are platform-specific strings, e.g.
//   Slack:    C0123:1700000000.0001          (channel:thread)
//   Telegram: tg:-100123:7:0                 (chat:topic:generation)
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/threads.json');
let threads = {};
try {
  threads = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  threads = {};
}

let timer;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(threads, null, 2));
  }, 200);
}
process.on('exit', () => {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(threads, null, 2)); } catch {}
});

export const threadKey = (channel, threadTs) => `${channel}:${threadTs}`;

export function getThread(key) {
  return threads[key];
}

export function setThread(key, value) {
  threads[key] = { ...threads[key], ...value, updatedAt: Date.now() };
  save();
}

// Small generic key/value store on top of the same file (e.g. Telegram topic → channel).
export function getMeta(key) {
  return threads[`meta:${key}`]?.value;
}
export function setMeta(key, value) {
  threads[`meta:${key}`] = { value, updatedAt: Date.now() };
  save();
}
