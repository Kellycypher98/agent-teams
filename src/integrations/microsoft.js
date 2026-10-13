// Outlook mail + calendar for a personal Microsoft account (outlook.com / hotmail) via Microsoft Graph.
// Needs MS_CLIENT_ID and a refresh token from `npm run auth:microsoft`.
// Microsoft rotates refresh tokens on every use, so the latest one is kept in data/ms-token.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MS_SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite';
const TOKEN_FILE = path.resolve('data/ms-token.json');
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';

// Use the rotated token from data/ms-token.json, unless .env holds a newer login (re-ran auth).
const seed = () => (process.env.MS_REFRESH_TOKEN ? crypto.createHash('sha256').update(process.env.MS_REFRESH_TOKEN).digest('hex').slice(0, 16) : null);
const storedRefresh = () => {
  try {
    const f = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return !seed() || f.seed === seed() ? f.refresh_token : null;
  } catch { return null; }
};
export const microsoftEnabled = () => Boolean(process.env.MS_CLIENT_ID && (storedRefresh() || process.env.MS_REFRESH_TOKEN));

let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: storedRefresh() || process.env.MS_REFRESH_TOKEN,
      scope: MS_SCOPES,
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    throw new Error(j.error === 'invalid_grant'
      ? 'Outlook login expired; run `npm run auth:microsoft` again'
      : `Microsoft auth failed: ${j.error_description?.split('\r\n')[0] || j.error}`);
  }
  if (j.refresh_token) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: j.refresh_token, seed: seed(), savedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function graph(url, opts = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    ...opts,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (res.status === 202 || res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Outlook ${res.status}: ${j.error?.message || res.statusText}`);
  return j;
}

const addr = (list) => (Array.isArray(list) ? list : list ? [list] : []).filter(Boolean).map((a) => ({ emailAddress: { address: a } }));
const fmtFrom = (f) => (f?.emailAddress ? `${f.emailAddress.name || ''} <${f.emailAddress.address}>`.trim() : '');

// ---------- Mail ----------
export async function outlookSearch(query, max = 10) {
  const select = '$select=id,subject,from,receivedDateTime,bodyPreview,isRead';
  const top = `$top=${Math.min(max, 25)}`;
  const url = query
    ? `/messages?$search=${encodeURIComponent(`"${query.replace(/"/g, '')}"`)}&${top}&${select}`
    : `/mailFolders/inbox/messages?$orderby=receivedDateTime desc&${top}&${select}`;
  const j = await graph(url);
  return (j.value || []).map((m) => ({ account: 'outlook', id: m.id, from: fmtFrom(m.from), subject: m.subject,
    date: m.receivedDateTime, unread: !m.isRead, snippet: m.bodyPreview }));
}

export async function outlookRead(id) {
  const m = await graph(`/messages/${id}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } });
  let attachments = [];
  if (m.hasAttachments) attachments = ((await graph(`/messages/${id}/attachments?$select=name`)).value || []).map((a) => a.name);
  return { account: 'outlook', id, from: fmtFrom(m.from), to: m.toRecipients.map(fmtFrom).join(', '), cc: m.ccRecipients.map(fmtFrom).join(', '),
    subject: m.subject, date: m.receivedDateTime, body: (m.body?.content || '').slice(0, 15000), attachments };
}

// Creates a draft (new or reply) with attachments and returns its id. Sending = draft + /send.
async function outlookCompose({ to, cc, subject, body, replyToId, attachments = [] }) {
  let draft;
  if (replyToId) {
    draft = await graph(`/messages/${replyToId}/createReply`, { method: 'POST', body: JSON.stringify({ comment: body }) });
    const patch = {};
    if (to?.length) patch.toRecipients = addr(to);
    if (cc?.length) patch.ccRecipients = addr(cc);
    if (subject) patch.subject = subject;
    if (Object.keys(patch).length) await graph(`/messages/${draft.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } else {
    draft = await graph('/messages', { method: 'POST', body: JSON.stringify({
      subject, body: { contentType: 'Text', content: body }, toRecipients: addr(to), ccRecipients: addr(cc),
    }) });
  }
  for (const a of attachments) {
    if (a.data.length > 3 * 1024 * 1024) throw new Error(`${a.filename} is over 3 MB, too big to attach via Outlook here`);
    await graph(`/messages/${draft.id}/attachments`, { method: 'POST', body: JSON.stringify({
      '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.mime, contentBytes: a.data.toString('base64'),
    }) });
  }
  return draft.id;
}

export const outlookDraft = (msg) => outlookCompose(msg);
export async function outlookSend(msg) {
  const id = await outlookCompose(msg);
  await graph(`/messages/${id}/send`, { method: 'POST' });
  return id;
}

// ---------- Calendar ----------
export async function outlookCalList(fromIso, toIso, tz) {
  const j = await graph(`/calendarView?${new URLSearchParams({ startDateTime: fromIso, endDateTime: toIso, $top: '100', $orderby: 'start/dateTime',
    $select: 'id,subject,start,end,location,isAllDay,showAs,isCancelled' })}`, { headers: { Prefer: `outlook.timezone="${tz}"` } });
  return (j.value || []).filter((e) => !e.isCancelled).map((e) => ({
    calendar: 'outlook', id: e.id, title: e.subject || '(no title)', location: e.location?.displayName || undefined,
    start: e.start.dateTime, end: e.end.dateTime, timeZone: tz, allDay: e.isAllDay, busy: e.showAs !== 'free',
  }));
}

export async function outlookCalCreate(e) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(e.start);
  const when = (v) => ({ dateTime: allDay ? `${v}T00:00:00` : (v.length === 16 ? `${v}:00` : v), timeZone: e.timezone });
  const r = await graph('/events', { method: 'POST', body: JSON.stringify({
    subject: e.title,
    body: e.description ? { contentType: 'text', content: e.description } : undefined,
    start: when(e.start), end: when(e.end), isAllDay: allDay,
    location: e.location ? { displayName: e.location } : undefined,
    attendees: e.attendees?.map((a) => ({ emailAddress: { address: a }, type: 'required' })),
    isReminderOn: e.reminderMinutes != null,
    reminderMinutesBeforeStart: e.reminderMinutes ?? undefined,
  }) });
  return r.webLink;
}
