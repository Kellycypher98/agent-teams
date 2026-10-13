// One-time Outlook login (personal Microsoft account). Run: npm run auth:microsoft
// Needs MS_CLIENT_ID in .env (Azure app registration, "Personal Microsoft accounts only",
// "Allow public client flows" = Yes). Uses a device code, so it works on your Mac or the server.
import 'dotenv/config';
import { MS_SCOPES } from '../src/integrations/microsoft.js';
import { setEnv } from './envfile.js';

const id = process.env.MS_CLIENT_ID;
if (!id) {
  console.error('Add MS_CLIENT_ID to .env first (see README → Email & calendar).');
  process.exit(1);
}
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

const dc = await (await fetch(`${AUTH}/devicecode`, { method: 'POST', body: new URLSearchParams({ client_id: id, scope: MS_SCOPES }) })).json();
if (!dc.device_code) { console.error('❌', dc.error_description || dc.error); process.exit(1); }
console.log(`\nOpen ${dc.verification_uri} and enter the code:  ${dc.user_code}\n(waiting…)`);

const deadline = Date.now() + dc.expires_in * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000));
  const r = await fetch(`${AUTH}/token`, { method: 'POST', body: new URLSearchParams({
    client_id: id, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code,
  }) });
  const j = await r.json();
  if (j.error === 'authorization_pending') continue;
  if (j.error === 'slow_down') { await new Promise((res) => setTimeout(res, 5000)); continue; }
  if (!r.ok) { console.error('❌', j.error_description || j.error); process.exit(1); }
  setEnv('MS_REFRESH_TOKEN', j.refresh_token);
  const me = await (await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
  console.log(`\n✅ Outlook connected for ${me.userPrincipalName || me.mail || 'your account'}. Saved MS_REFRESH_TOKEN to .env.`);
  console.log('   Next: ./deploy/deploy.sh to copy it to the server.');
  process.exit(0);
}
console.error('❌ Code expired. Run it again.');
process.exit(1);
