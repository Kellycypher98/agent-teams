// One-time Google login (Gmail + Google Calendar). Run on your Mac: npm run auth:google
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (OAuth client of type "Desktop app").
// Saves GOOGLE_REFRESH_TOKEN to .env; deploy afterwards to copy it to the server.
import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { GOOGLE_SCOPES } from '../src/integrations/google.js';
import { setEnv } from './envfile.js';

const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first (see README → Email & calendar).');
  process.exit(1);
}

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(8).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  if (url.searchParams.get('state') !== state) { res.writeHead(400).end('State mismatch'); return; }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400).end(`Login failed: ${url.searchParams.get('error')}`); server.close(); return; }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      client_id: id, client_secret: secret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect,
    }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error);
    if (!j.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
    setEnv('GOOGLE_REFRESH_TOKEN', j.refresh_token);
    const me = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>✅ Connected. You can close this tab.</h2>');
    console.log(`\n✅ Google connected for ${me.emailAddress || 'your account'}. Saved GOOGLE_REFRESH_TOKEN to .env.`);
    console.log('   Next: ./deploy/deploy.sh to copy it to the server.');
  } catch (err) {
    res.writeHead(500).end(`Error: ${err.message}`);
    console.error(`\n❌ ${err.message}`);
  }
  server.close();
});

let redirect;
server.listen(0, '127.0.0.1', () => {
  redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const auth = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: id, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
  })}`;
  console.log('Opening your browser to sign in to Google…\nIf it doesn\'t open, paste this link:\n\n' + auth + '\n');
  exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${auth}"`, () => {});
});
