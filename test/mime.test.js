import { test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers.js';

const { buildMime } = await import(src('integrations/mime.js'));

test('builds a UTF-8 email with attachment and reply headers', () => {
  const raw = buildMime({ to: ['hr@firma.de'], cc: ['me@x.com'], subject: 'Bewerbung – Werkstudent', body: 'Grüße\nKelvin',
    inReplyTo: '<abc@mail>', attachments: [{ filename: 'CV.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4') }] });
  assert.match(raw, /^To: hr@firma\.de\r\nCc: me@x\.com\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  const subj = raw.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
  assert.equal(Buffer.from(subj, 'base64').toString(), 'Bewerbung – Werkstudent');
  assert.match(raw, /In-Reply-To: <abc@mail>\r\nReferences: <abc@mail>/);
  assert.match(raw, /multipart\/mixed; boundary="(b_\w+)"/);
  assert.match(raw, /Content-Disposition: attachment; filename="CV.pdf"/);
  const body = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), 'Grüße\nKelvin');
});
