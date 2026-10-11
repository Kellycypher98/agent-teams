// Remembers which teammate owns each Slack thread and their conversation session,
// so follow-ups in a thread continue the same conversation (even after a restart).
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/threads.json');
let threads = {};
try {
  threads = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  threads = {};
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(threads, null, 2));
}

export const threadKey = (channel, threadTs) => `${channel}:${threadTs}`;

export function getThread(key) {
  return threads[key];
}

export function setThread(key, value) {
  threads[key] = { ...threads[key], ...value, updatedAt: Date.now() };
  save();
}
