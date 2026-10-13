import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, src } from './helpers.js';

sandbox();
const { registerExecutor, requestApproval, decide, getApproval } = await import(src('approvals.js'));

const asked = [];
const target = { askApproval: async (agent, id, text) => asked.push({ agent, id, text }) };

test('runs the action only after approval, exactly once', async () => {
  let runs = 0;
  registerExecutor('t_send', async (p) => { runs++; return `sent to ${p.to}`; });
  const id = await requestApproval(target, 'assistant', 't_send', { to: 'a@b.c' }, 'preview');
  assert.equal(asked.at(-1).id, id);
  assert.equal(runs, 0);
  assert.equal(await decide(id, true), '✅ sent to a@b.c');
  assert.equal(await decide(id, true), 'Already done.');
  assert.equal(runs, 1);
});

test('cancel never runs the action', async () => {
  let runs = 0;
  registerExecutor('t_cancel', async () => { runs++; return 'x'; });
  const id = await requestApproval(target, 'assistant', 't_cancel', {}, 'p');
  assert.match(await decide(id, false), /Cancelled/);
  assert.equal(await decide(id, true), 'Already cancelled.');
  assert.equal(runs, 0);
});

test('a failed action stays pending so it can be retried', async () => {
  let fail = true;
  registerExecutor('t_flaky', async () => { if (fail) { fail = false; throw new Error('network blip'); } return 'ok'; });
  const id = await requestApproval(target, 'assistant', 't_flaky', {}, 'p');
  assert.match(await decide(id, true), /Failed: network blip/);
  assert.equal(getApproval(id).status, 'pending');
  assert.equal(await decide(id, true), '✅ ok');
});

test('unknown ids are rejected', async () => {
  assert.match(await decide('nope', true), /no longer exists/);
});
