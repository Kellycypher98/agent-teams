import { test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers.js';

const { buildIcs, localToUtc } = await import(src('outbox.js'));
const unfold = (s) => s.replace(/\r\n /g, '');

test('converts Berlin local time to UTC across DST', () => {
  assert.equal(localToUtc('2026-10-20T14:00', 'Europe/Berlin').toISOString(), '2026-10-20T12:00:00.000Z'); // CEST
  assert.equal(localToUtc('2026-10-26T09:00', 'Europe/Berlin').toISOString(), '2026-10-26T08:00:00.000Z'); // CET
  assert.equal(localToUtc('2026-10-25T01:00', 'Europe/Berlin').toISOString(), '2026-10-24T23:00:00.000Z'); // night DST ends
});

test('builds valid events: timed, all-day, recurring, reminder', () => {
  const ics = unfold(buildIcs([
    { title: 'Supervisor meeting, room 2.14', start: '2026-10-20T14:00', durationMinutes: 45, reminderMinutes: 30, description: 'Bring outline;\nchapter 2' },
    { title: 'Deadline', start: '2026-12-15' },
    { title: 'Lecture', start: '2026-10-26T09:00', end: '2026-10-26T11:30', recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=8' },
  ]));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261020T120000Z\r\nDTEND:20261020T124500Z/);
  assert.match(ics, /SUMMARY:Supervisor meeting\\, room 2\.14/);
  assert.ok(ics.includes('DESCRIPTION:Bring outline\\;\\nchapter 2'), 'escapes ; and newlines');
  assert.match(ics, /TRIGGER:-PT30M/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261215\r\nDTEND;VALUE=DATE:20261216/);
  assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20261026T090000/, 'recurring events stay in local time');
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8/);
});

test('folds long lines at 75 octets and rejects bad input', () => {
  const raw = buildIcs([{ title: 'x'.repeat(200), start: '2026-11-01T10:00' }]);
  for (const line of raw.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.throws(() => buildIcs([{ title: 'a', start: '2026-11-01T10:00', end: '2026-11-01T09:00' }]), /ends before/);
  assert.throws(() => buildIcs([{ title: 'a', start: 'next tuesday' }]), /bad date/);
  assert.throws(() => buildIcs([{ title: 'a', start: '2026-11-01T10:00', recurrence: 'FREQ=WEEKLY\nBEGIN:VALARM' }]), /bad recurrence/);
});
