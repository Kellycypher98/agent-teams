import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, src } from './helpers.js';

sandbox();
const { addressed, addressedAll, route } = await import(src('router.js'));

test('finds the teammate a message starts with', () => {
  assert.equal(addressed('Kai, fix the login bug'), 'code');
  assert.equal(addressed('hey nova what is an SBOM'), 'research');
  assert.equal(addressed('okay Remy thanks'), 'writer');
  assert.equal(addressed('can you help'), undefined);
});

test('finds every teammate addressed at the start', () => {
  assert.deepEqual(addressedAll('Kai and Nova, check this'), ['code', 'research']);
  assert.deepEqual(addressedAll('hey Remy, Iris: plan my week'), ['writer', 'assistant']);
  assert.deepEqual(addressedAll('Nova & Remy & Kai thoughts?'), ['research', 'writer', 'code']);
  assert.deepEqual(addressedAll('Remy, send it to Iris'), ['writer'], 'names later in the sentence are not addressees');
  assert.deepEqual(addressedAll('run the tests'), []);
});

test('falls back to the channel default when the router model is unreachable', async () => {
  assert.equal(await route('something vague', ['research', 'writer']), 'research');
  assert.equal(await route('anything', ['writer']), 'writer');
});
