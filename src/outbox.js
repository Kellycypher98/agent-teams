// Tools that let teammates send files back into the conversation (Slack thread or Telegram chat).
//   create_calendar_file → a valid .ics (Apple / Google / Outlook) with one or more events
//   share_file           → any text file (csv, md, json, code, …)
// On Slack this needs the files:write scope.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import crypto from 'node:crypto';
import { log } from './log.js';
import { OWNER } from './profile.js';

export const DEFAULT_TZ = process.env.BUDGET_TZ || process.env.TZ_DEFAULT || 'Europe/Berlin';
export const OUTBOX_TOOLS = ['mcp__files__create_calendar_file', 'mcp__files__share_file'];

// ---------- iCalendar helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const utcStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const escapeText = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// RFC 5545 line folding: max 75 octets per line, continuation lines start with a space.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function tzOffsetMs(ts, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ts;
}

// "2026-10-15T14:30" in Europe/Berlin → Date (UTC)
export function localToUtc(local, tz) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`bad date "${local}"; use YYYY-MM-DD or YYYY-MM-DDTHH:mm`);
  const [, Y, M, D, h = '0', mi = '0', s = '0'] = m;
  const wall = Date.UTC(+Y, +M - 1, +D, +h, +mi, +s);
  let ts = wall - tzOffsetMs(wall, tz);
  ts = wall - tzOffsetMs(ts, tz); // second pass handles DST edges
  return new Date(ts);
}

const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dateValue = (s) => s.replace(/-/g, '');
const nextDay = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export function buildIcs(events, calName = 'Agent Team') {
  const now = utcStamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Agent Team//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(calName)}`];
  for (const e of events) {
    const tz = e.timezone || DEFAULT_TZ;
    new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on an unknown timezone
    lines.push('BEGIN:VEVENT', `UID:${crypto.randomUUID()}@agent-team`, `DTSTAMP:${now}`);
    if (isDateOnly(e.start)) {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(e.start)}`);
      lines.push(`DTEND;VALUE=DATE:${dateValue(e.end && isDateOnly(e.end) ? nextDay(e.end) : nextDay(e.start))}`);
    } else {
      const start = localToUtc(e.start, tz);
      const end = e.end ? localToUtc(e.end, tz) : new Date(start.getTime() + (e.durationMinutes || 60) * 60000);
      if (end <= start) throw new Error(`"${e.title}" ends before it starts`);
      if (e.recurrence) {
        // Repeating events stay in local time so they don't shift an hour when DST changes.
        const local = (d) => {
          const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            .formatToParts(d).map((x) => [x.type, x.value]));
          return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
        };
        lines.push(`DTSTART;TZID=${tz}:${local(start)}`, `DTEND;TZID=${tz}:${local(end)}`);
      } else {
        lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
      }
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.recurrence) {
      const rule = e.recurrence.replace(/^RRULE:/i, '').toUpperCase();
      if (!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+\-]+)*$/.test(rule)) throw new Error(`bad recurrence "${e.recurrence}"`);
      lines.push(`RRULE:${rule}`);
    }
    if (e.reminderMinutes != null && e.reminderMinutes >= 0) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:-PT${Math.round(e.reminderMinutes)}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

const safeName = (s, ext) => {
  const base = String(s || 'file').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'file';
  return ext && !base.toLowerCase().endsWith(ext) ? `${base}${ext}` : base;
};


const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** An MCP server bound to one conversation, so uploads land in the right place. */
export function outboxServer(target, agentKey) {
  const agentName = agentKey;
  const upload = (_t, filename, content, title) => target.sendFile(agentKey, filename, Buffer.from(content, 'utf8'), title || filename);
  const event = z.object({
    title: z.string().describe('Event title'),
    start: z.string().describe('Local start: "YYYY-MM-DDTHH:mm", or "YYYY-MM-DD" for an all-day event'),
    end: z.string().optional().describe('Local end, same format as start. Omit to use durationMinutes'),
    durationMinutes: z.number().optional().describe('Used when end is omitted (default 60)'),
    timezone: z.string().optional().describe(`IANA timezone, default ${DEFAULT_TZ}`),
    location: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    reminderMinutes: z.number().optional().describe('Alert this many minutes before'),
    recurrence: z.string().optional().describe('RRULE, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"'),
  });

  return createSdkMcpServer({
    name: 'files',
    version: '1.0.0',
    tools: [
      tool('create_calendar_file',
        `Create an .ics calendar file with one or more events and post it in this conversation. ${OWNER} taps it to add the events to his calendar.`,
        { filename: z.string().optional().describe('e.g. "thesis-deadlines"'), events: z.array(event).min(1).max(100) },
        async ({ filename, events }) => {
          try {
            const name = safeName(filename || events[0].title, '.ics');
            await upload(null, name, buildIcs(events, filename || 'Agent Team'), name);
            log.info('file sent', { agent: agentName, file: name, events: events.length });
            return ok(`Posted ${name} with ${events.length} event(s) in the thread. Don't paste the file contents in your reply.`);
          } catch (err) {
            log.warn('calendar file failed', { agent: agentName, err });
            return fail(`Couldn't create the calendar file: ${err.data?.error === 'missing_scope' ? 'the Slack app needs the files:write scope' : err.message}`);
          }
        }),
      tool('share_file',
        'Post a text file (csv, md, txt, json, code, etc.) in this conversation.',
        { filename: z.string().describe('Name with extension, e.g. "budget.csv"'), content: z.string().max(1_000_000), title: z.string().optional() },
        async ({ filename, content, title }) => {
          try {
            const name = safeName(filename);
            await upload(null, name, content, title);
            log.info('file sent', { agent: agentName, file: name, kb: Math.round(Buffer.byteLength(content) / 1024) });
            return ok(`Posted ${name} in the thread. Don't paste the file contents in your reply.`);
          } catch (err) {
            log.warn('share file failed', { agent: agentName, err });
            return fail(`Couldn't post the file: ${err.data?.error === 'missing_scope' ? 'the Slack app needs the files:write scope' : err.message}`);
          }
        }),
    ],
  });
}
