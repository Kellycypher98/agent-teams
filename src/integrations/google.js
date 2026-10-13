// Gmail + Google Calendar over plain REST (no googleapis dependency).
// Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (from `npm run auth:google`).
import { buildMime, toBase64Url, fromBase64Url, htmlToText } from './mime.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
];

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    throw new Error(j.error === 'invalid_grant'
      ? 'Google login expired; run `npm run auth:google` again (and set the OAuth app to "In production" so it stops expiring)'
      : `Google auth failed: ${j.error_description || j.error}`);
  }
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function gapi(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${j.error?.message || res.statusText}`);
  return j;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// ---------- Gmail ----------
export async function gmailSearch(query = 'in:inbox', max = 10) {
  const list = await gapi(`${GMAIL}/messages?${new URLSearchParams({ q: query || 'in:inbox', maxResults: String(Math.min(max, 25)) })}`);
  const ids = (list.messages || []).map((m) => m.id);
  return Promise.all(ids.map(async (id) => {
    const m = await gapi(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    return { account: 'gmail', id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'),
      unread: m.labelIds?.includes('UNREAD') || false, snippet: m.snippet };
  }));
}

function walkParts(part, out = { text: '', html: '', attachments: [] }) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.attachments.push(part.filename);
  else if (part.mimeType === 'text/plain' && part.body?.data) out.text += fromBase64Url(part.body.data).toString('utf8');
  else if (part.mimeType === 'text/html' && part.body?.data) out.html += fromBase64Url(part.body.data).toString('utf8');
  for (const p of part.parts || []) walkParts(p, out);
  return out;
}

export async function gmailRead(id) {
  const m = await gapi(`${GMAIL}/messages/${id}?format=full`);
  const { text, html, attachments } = walkParts(m.payload);
  return {
    account: 'gmail', id, threadId: m.threadId,
    from: header(m, 'From'), to: header(m, 'To'), cc: header(m, 'Cc'), subject: header(m, 'Subject'), date: header(m, 'Date'),
    messageId: header(m, 'Message-ID'), references: header(m, 'References'),
    body: (text || htmlToText(html)).slice(0, 15000), attachments,
  };
}

async function gmailCompose({ replyToId, ...msg }) {
  let threadId;
  if (replyToId) {
    const orig = await gmailRead(replyToId);
    threadId = orig.threadId;
    msg.inReplyTo = orig.messageId;
    msg.references = [orig.references, orig.messageId].filter(Boolean).join(' ');
    if (!msg.subject) msg.subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    if (!msg.to?.length) msg.to = [orig.from];
  }
  return { raw: toBase64Url(buildMime(msg)), threadId };
}

export async function gmailDraft(msg) {
  const { raw, threadId } = await gmailCompose(msg);
  const d = await gapi(`${GMAIL}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw, threadId } }) });
  return d.id;
}

export async function gmailSend(msg) {
  const { raw, threadId } = await gmailCompose(msg);
  const s = await gapi(`${GMAIL}/messages/send`, { method: 'POST', body: JSON.stringify({ raw, threadId }) });
  return s.id;
}

// ---------- Google Calendar ----------
export async function gcalList(fromIso, toIso) {
  const j = await gapi(`${CAL}/events?${new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime', maxResults: '100' })}`);
  return (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    calendar: 'google', id: e.id, title: e.summary || '(no title)', location: e.location,
    start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date, allDay: Boolean(e.start.date),
    busy: e.transparency !== 'transparent',
  }));
}

export async function gcalCreate(e) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(e.start);
  const when = (v) => (allDay ? { date: v } : { dateTime: `${v.length === 16 ? `${v}:00` : v}`, timeZone: e.timezone });
  const body = {
    summary: e.title, location: e.location, description: e.description,
    start: when(e.start), end: when(e.end),
    attendees: e.attendees?.map((email) => ({ email })),
    reminders: e.reminderMinutes != null ? { useDefault: false, overrides: [{ method: 'popup', minutes: e.reminderMinutes }] } : undefined,
  };
  const r = await gapi(`${CAL}/events?sendUpdates=${e.attendees?.length ? 'all' : 'none'}`, { method: 'POST', body: JSON.stringify(body) });
  return r.htmlLink;
}
