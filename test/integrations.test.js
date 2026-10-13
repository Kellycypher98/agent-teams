// Gmail, Google Calendar and Outlook flows against a fake HTTP layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox, src } from './helpers.js';

sandbox({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', MS_CLIENT_ID: 'm', MS_REFRESH_TOKEN: 'mr' });
fs.mkdirSync('workspace/uploads/t', { recursive: true });
fs.writeFileSync('workspace/uploads/t/CV.pdf', '%PDF cv');
fs.writeFileSync('.env', 'SECRET=1');

const calls = [];
const b64 = (s) => Buffer.from(s).toString('base64url');
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); const method = opts.method || 'GET';
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  calls.push({ method, url, body: opts.body });
  if (url.includes('oauth2.googleapis.com/token')) return J({ access_token: 'gt', expires_in: 3600 });
  if (url.includes('login.microsoftonline.com')) return J({ access_token: 'mt', refresh_token: 'rotated', expires_in: 3600 });
  if (url.includes('/messages/m1?format=full')) return J({ id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain',
    headers: [{ name: 'From', value: 'HR <hr@co.de>' }, { name: 'Subject', value: 'Interview' }, { name: 'Message-ID', value: '<id1@co>' }], body: { data: b64('Thursday?') } } });
  if (url.endsWith('/messages/send')) return J({ id: 's1' });
  if (url.includes('/calendar/v3/calendars/primary/events?') && method === 'POST') return J({ htmlLink: 'https://cal/e' });
  if (url.endsWith('/v1.0/me/messages') && method === 'POST') return J({ id: 'd1' });
  if (url.includes('/me/messages/d1/attachments')) return J({ id: 'a1' });
  if (url.includes('/me/messages/d1/send')) return new Response(null, { status: 202 });
  return J({ error: { message: `unmocked ${url}` } }, 404);
};

await import(src('integrations/index.js'));
const { requestApproval, decide } = await import(src('approvals.js'));
const asked = [];
const target = { askApproval: async (a, id) => asked.push(id) };
const approve = async (kind, params) => { await requestApproval(target, 'assistant', kind, params, 'p'); return decide(asked.at(-1), true); };

test('Gmail reply stays in the thread and attaches the CV', async () => {
  const r = await approve('send_email', { account: 'gmail', body: 'Thursday works.', replyToId: 'm1', attachments: ['uploads/t/CV.pdf'] });
  assert.match(r, /^✅ Sent/);
  const send = calls.find((c) => c.url.endsWith('/messages/send'));
  const { raw, threadId } = JSON.parse(send.body);
  const mime = Buffer.from(raw, 'base64url').toString();
  assert.equal(threadId, 't1');
  assert.match(mime, /In-Reply-To: <id1@co>/);
  assert.match(mime, /Subject: Re: Interview/);
  assert.match(mime, /To: HR <hr@co.de>/);
  assert.match(mime, /filename="CV.pdf"/);
});

test('Outlook send = draft, attach, send; rotated token is saved', async () => {
  assert.match(await approve('send_email', { account: 'outlook', to: ['a@b.de'], subject: 'Hi', body: 'Text', attachments: ['uploads/t/CV.pdf'] }), /^✅ Sent "Hi"/);
  const order = calls.filter((c) => c.url.includes('graph.microsoft.com')).map((c) => `${c.method} ${c.url.split('/v1.0/me')[1]}`);
  assert.deepEqual(order, ['POST /messages', 'POST /messages/d1/attachments', 'POST /messages/d1/send']);
  assert.equal(JSON.parse(fs.readFileSync('data/ms-token.json', 'utf8')).refresh_token, 'rotated');
});

test('Google Calendar event is created in local time', async () => {
  const r = await approve('create_event', { calendar: 'google', event: { title: 'Interview', start: '2026-10-15T15:00', end: '2026-10-15T16:00', timezone: 'Europe/Berlin', when: 'Thu 15 Oct' } });
  assert.match(r, /Added "Interview" to Google Calendar/);
  const body = JSON.parse(calls.find((c) => c.url.includes('/calendar/v3') && c.method === 'POST').body);
  assert.deepEqual(body.start, { dateTime: '2026-10-15T15:00:00', timeZone: 'Europe/Berlin' });
});

test('attachments cannot escape the workspace', async () => {
  const before = calls.length;
  assert.match(await approve('send_email', { account: 'gmail', to: ['x@y.z'], subject: 's', body: 'b', attachments: ['../.env'] }), /outside the workspace/);
  assert.equal(calls.slice(before).filter((c) => c.url.endsWith('/send')).length, 0);
});
