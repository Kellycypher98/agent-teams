// Set KEY=value in .env (replace if present, append if not), keeping everything else intact.
import fs from 'node:fs';
import path from 'node:path';

export function setEnv(key, value, file = path.resolve('.env')) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
}
