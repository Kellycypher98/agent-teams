// Minimal RFC 5322 / MIME builder for Gmail (UTF-8 text body + optional attachments).
import crypto from 'node:crypto';

const encodeHeader = (s = '') => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const list = (x) => (Array.isArray(x) ? x : x ? [x] : []).filter(Boolean).join(', ');

export function buildMime({ to, cc, bcc, subject, body, inReplyTo, references, attachments = [], from }) {
  const headers = [
    from && `From: ${from}`,
    `To: ${list(to)}`,
    list(cc) && `Cc: ${list(cc)}`,
    list(bcc) && `Bcc: ${list(bcc)}`,
    `Subject: ${encodeHeader(subject || '')}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`,
    (references || inReplyTo) && `References: ${references || inReplyTo}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(body || '', 'utf8').toString('base64')),
  ].join('\r\n');

  if (!attachments.length) return `${headers.join('\r\n')}\r\n${textPart}\r\n`;

  const boundary = `b_${crypto.randomBytes(12).toString('hex')}`;
  const parts = [textPart, ...attachments.map((a) => [
    `Content-Type: ${a.mime || 'application/octet-stream'}; name="${encodeHeader(a.filename)}"`,
    `Content-Disposition: attachment; filename="${encodeHeader(a.filename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(a.data.toString('base64')),
  ].join('\r\n'))];
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('') + `--${boundary}--\r\n`;
}

export const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64Url = (s = '') => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function htmlToText(html = '') {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
