import { test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers.js';

const { toTelegramHtml: html, splitForTelegram } = await import(src('adapters/telegram-format.js'));

test('converts Slack mrkdwn to Telegram HTML', () => {
  assert.equal(html('*Done:* found _3_ sources'), '<b>Done:</b> found <i>3</i> sources');
  assert.equal(html('see <https://ex.com/a?b=1&c=2|Paper A>'), 'see <a href="https://ex.com/a?b=1&amp;c=2">Paper A</a>');
  assert.equal(html('**old md** and [link](https://x.y)'), '<b>old md</b> and <a href="https://x.y">link</a>');
  assert.equal(html('<@U123> hi'), 'hi');
});

test('escapes HTML and keeps code verbatim', () => {
  assert.equal(html('```js\nif (a < b && c) {}\n```'), '<pre>if (a &lt; b &amp;&amp; c) {}</pre>');
  assert.equal(html('run `npm i *x*`'), 'run <code>npm i *x*</code>');
});

test('does not treat maths or snake_case as formatting', () => {
  assert.equal(html('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
  assert.equal(html('snake_case_name'), 'snake_case_name');
});

test('splits long messages under the 4096-char limit', () => {
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i} with some text to fill`).join('\n');
  const parts = splitForTelegram(long);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(html(p).length < 4096);
  assert.equal(parts.join('').replace(/\n/g, ''), long.replace(/\n/g, ''));
});
