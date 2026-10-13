// End-to-end: four Telegram bots against a fake Bot API, with the Claude Agent SDK mocked.
// Covers group fan-out, shared context, @mentions, hand-offs, the morning X-post routine,
// routine creation via approval buttons, and command parsing.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, src, until, ROOT } from './helpers.js';

sandbox();

// ---- fake Agent SDK: records who ran, can trigger team tools ----
const seen = [];
mock.module(pathToFileURL(path.join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).href, { namedExports: {
  tool: (name, d, schema, handler) => ({ name, handler }),
  createSdkMcpServer: ({ name, tools }) => ({ name, tools }),
  query: ({ prompt, options }) => (async function* () {
    let text = prompt;
    if (typeof prompt !== 'string') for await (const m of prompt) text = m.message.content[0].text;
    const name = options.systemPrompt.match(/You are (\w+)/)[1];
    seen.push({ name, text, shared: /Recent messages in this conversation/.test(options.systemPrompt) });
    const team = options.mcpServers.team.tools;
    const call = (t, args) => team.find((x) => x.name === t).handler(args);
    if (name === 'Remy' && text.includes('HANDOFF')) await call('ask_teammate', { teammate: 'Iris', message: 'Draft: "Shipping my agent team today"' });
    if (name === 'Nova' && text.includes('PROPOSE')) await call('create_routine', { name: 'Friday news', time: '17:00', days: ['fri'], steps: [{ teammate: 'Nova', task: '3 security news items' }], deliver: 'dm' });
    const result = name === 'Remy' && text.includes("today's post") ? `Tip ${seen.length}: rotate your API keys, don't just hide them.` : `${name} replying`;
    yield { type: 'result', subtype: 'success', result, total_cost_usd: 0.001, num_turns: 1, session_id: `s-${name}-${seen.length}` };
  })(),
} });

// ---- fake Telegram Bot API ----
const OWNER = 555, GROUP = -1001;
const BOTS = { 'tok-kai': [11, 'kai_bot'], 'tok-nova': [12, 'nova_bot'], 'tok-remy': [13, 'remy_bot'], 'tok-iris': [14, 'iris_bot'] };
const queues = Object.fromEntries(Object.keys(BOTS).map((t) => [t, []]));
const sent = [];
let msgId = 1000, upd = 1;
const srv = http.createServer((req, res) => { let body = ''; req.on('data', (c) => (body += c)); req.on('end', async () => {
  const [, token, method] = req.url.match(/^\/bot([^/]+)\/(.+)$/);
  const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
  const p = body ? JSON.parse(body) : {};
  if (method === 'getUpdates') { if (!queues[token].length) await new Promise((r) => setTimeout(r, 50)); return ok(queues[token].splice(0)); }
  if (method === 'getMe') return ok({ id: BOTS[token][0], is_bot: true, first_name: BOTS[token][1], username: BOTS[token][1], can_read_all_group_messages: true });
  if (['sendMessage', 'editMessageText'].includes(method)) sent.push({ bot: BOTS[token][1], chat: p.chat_id, text: p.text, buttons: Boolean(p.reply_markup) });
  ok(method === 'sendMessage' ? { message_id: ++msgId, chat: { id: p.chat_id }, date: 0, text: p.text } : true);
}); }).listen(0);
await new Promise((r) => srv.on('listening', r));
Object.assign(process.env, { TELEGRAM_API_ROOT: `http://127.0.0.1:${srv.address().port}`, TELEGRAM_OWNER_ID: String(OWNER), TELEGRAM_LEAD: 'Remy',
  TELEGRAM_TOKEN_KAI: 'tok-kai', TELEGRAM_TOKEN_NOVA: 'tok-nova', TELEGRAM_TOKEN_REMY: 'tok-remy', TELEGRAM_TOKEN_IRIS: 'tok-iris',
  TELEGRAM_ALERTS: 'false', X_POST_TIME: '23:59' });

const { startTelegram } = await import(src('adapters/telegram.js'));
const { startRoutines, allRoutines } = await import(src('routines.js'));
await startTelegram(); startRoutines();
after(() => setTimeout(() => process.exit(0), 50));

const user = { id: OWNER, is_bot: false, first_name: 'Kelvin' };
const push = (tok, u) => queues[tok].push({ update_id: upd++, ...u });
const gm = (text, extra = {}) => ({ message: { message_id: ++msgId, from: user, chat: { id: GROUP, type: 'supergroup', title: 'Team', is_forum: true }, date: 0, text, message_thread_id: 20, is_topic_message: true, ...extra } });
const dm = (text) => ({ message: { message_id: ++msgId, from: user, chat: { id: OWNER, type: 'private' }, date: 0, text } });
const names = () => seen.map((x) => x.name);
const reset = () => { seen.length = 0; return sent.length; };
const settle = () => new Promise((r) => setTimeout(r, 400));

test('naming two teammates gets a reply from each', async () => {
  reset(); push('tok-remy', gm('Kai and Nova, should I add 2FA to Aloud?'));
  await until(() => seen.length === 2); await settle();
  assert.deepEqual(names().sort(), ['Kai', 'Nova']);
});

test('follow-ups go to the same group, and each sees what the other said', async () => {
  reset(); push('tok-remy', gm('ok, what would it cost in dev time?'));
  await until(() => seen.length === 2); await settle();
  assert.deepEqual(names().sort(), ['Kai', 'Nova']);
  assert.ok(seen.every((x) => x.shared));
});

test('two @mentions reach both bots', async () => {
  reset(); push('tok-remy', gm('@kai_bot @iris_bot block 2 hours Friday for it', { entities: [{ type: 'mention', offset: 0, length: 8 }, { type: 'mention', offset: 9, length: 9 }] }));
  await until(() => seen.length === 2); await settle();
  assert.deepEqual(names().sort(), ['Iris', 'Kai']);
});

test('Remy hands off to Iris, who answers in her own DM', async () => {
  const mark = reset(); push('tok-remy', dm('write a launch tweet HANDOFF to Iris'));
  await until(() => seen.length === 2); await settle();
  assert.deepEqual(names(), ['Remy', 'Iris']);
  assert.match(seen[1].text, /Remy \(.*\) asks you:[\s\S]*Shipping my agent team/);
  assert.ok(sent.slice(mark).some((s) => s.bot === 'iris_bot' && s.chat === OWNER));
});

test('morning X-post routine: Remy drafts, Iris delivers, Remy remembers past posts', async () => {
  const mark = reset(); push('tok-iris', dm('run x-post'));
  await until(() => seen.length === 2); await settle();
  assert.deepEqual(names(), ['Remy', 'Iris']);
  assert.match(seen[1].text, /rotate your API keys/, 'Iris receives Remy\'s draft');
  assert.ok(sent.slice(mark).some((s) => s.bot === 'iris_bot' && s.chat === OWNER && !/on it/.test(s.text)));
  assert.ok(!sent.slice(mark).some((s) => s.bot === 'remy_bot'), 'Remy works silently');
  reset(); push('tok-iris', dm('run x-post'));
  await until(() => seen.length === 2); await settle();
  assert.match(seen[0].text, /recent outputs/);
});

test('replying in Iris\'s DM continues with Iris, who sees the draft', async () => {
  reset(); push('tok-iris', dm('make it punchier'));
  await until(() => seen.length === 1); await settle();
  assert.equal(seen[0].name, 'Iris');
  assert.ok(seen[0].shared);
});

test('a proposed routine starts only after tapping ✅', async () => {
  const mark = reset(); push('tok-nova', dm('every friday 5pm send me 3 security news PROPOSE'));
  await until(() => sent.slice(mark).some((s) => s.buttons));
  assert.ok(!allRoutines().some((r) => r.name === 'Friday news'));
  const id = fs.readFileSync('data/approvals.json', 'utf8').match(/"id": "(\w+)"[^}]*"kind": "create_routine"/)[1];
  push('tok-nova', { callback_query: { id: 'cb', from: user, chat_instance: 'c', data: `ap:${id}:y`, message: { message_id: 5, chat: { id: OWNER, type: 'private' }, date: 0, text: 'Start routine?' } } });
  await until(() => allRoutines().some((r) => r.name === 'Friday news' && r.time === '17:00'));
});

test('"run the tests" is a normal message, not a routine command', async () => {
  reset(); push('tok-remy', gm('run the tests please'));
  await until(() => seen.length >= 1); await settle();
  assert.ok(seen.length >= 1);
});

test('strangers are ignored', async () => {
  reset(); push('tok-kai', { message: { message_id: ++msgId, from: { id: 999, is_bot: false, first_name: 'X' }, chat: { id: 999, type: 'private' }, date: 0, text: 'hi Kai' } });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(seen.length, 0);
});
