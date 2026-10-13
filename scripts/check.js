// Syntax-check every source file (node --check only takes one file at a time).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['src', 'scripts', 'test'].flatMap((dir) =>
  readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`));
const bad = files.filter((f) => spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' }).status !== 0);
console.log(bad.length ? `✗ ${bad.length} file(s) failed` : `✓ ${files.length} files OK`);
process.exit(bad.length ? 1 : 0);
