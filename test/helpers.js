// Shared test setup: run each test file in a throwaway directory so data/ never touches the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const src = (p) => path.join(ROOT, 'src', p);

export function sandbox(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-test-'));
  process.chdir(dir);
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error', WORKSPACE_DIR: './workspace' }, env);
  return dir;
}

export async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for condition');
}
