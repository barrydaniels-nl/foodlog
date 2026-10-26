import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';

let server;
let client;

beforeEach(async () => {
  server = await startTestServer();
  client = api(server.url);
});
afterEach(() => server.close());

const DEFAULTS = {
  kcalTarget: 2000,
  proteinTarget: 120,
  offCountry: 'nl',
  sex: null,
  birthYear: null,
  microTargets: {},
};

test('returns defaults when nothing is stored', async () => {
  const res = await client.get('/api/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, DEFAULTS);
});

test('PUT persists a partial update and keeps other fields', async () => {
  const res = await client.put('/api/settings', { kcalTarget: 2200 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...DEFAULTS, kcalTarget: 2200 });
  assert.deepEqual((await client.get('/api/settings')).body.kcalTarget, 2200);
});

test('rejects out-of-range targets', async () => {
  const res = await client.put('/api/settings', { kcalTarget: 50 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /kcalTarget/);
});

test('rejects an unknown OFF country code', async () => {
  const res = await client.put('/api/settings', { offCountry: 'Netherlands' });
  assert.equal(res.status, 400);
});

test('rejects a country without Open Food Facts support', async () => {
  const res = await client.put('/api/settings', { offCountry: 'zz' });
  assert.equal(res.status, 400);
});

test('saves sex, birthYear and microTargets', async () => {
  const res = await client.put('/api/settings', { sex: 'female', birthYear: 1990, microTargets: { iron: 20, vitaminD: 25 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...DEFAULTS, sex: 'female', birthYear: 1990, microTargets: { iron: 20, vitaminD: 25 } });
  assert.deepEqual((await client.get('/api/settings')).body, res.body);
});

test('microTargets replaces the whole map and other updates leave it alone', async () => {
  await client.put('/api/settings', { microTargets: { iron: 20 } });
  await client.put('/api/settings', { kcalTarget: 2100 });
  assert.deepEqual((await client.get('/api/settings')).body.microTargets, { iron: 20 });
  await client.put('/api/settings', { microTargets: { zinc: 12 } });
  assert.deepEqual((await client.get('/api/settings')).body.microTargets, { zinc: 12 });
});

test('rejects birthYear under 18', async () => {
  const tooYoung = await client.put('/api/settings', { birthYear: 2009 });
  assert.equal(tooYoung.status, 400);
  assert.match(tooYoung.body.error, /birthYear/);
  const oldEnough = await client.put('/api/settings', { birthYear: 2008 });
  assert.equal(oldEnough.status, 200);
  assert.equal(oldEnough.body.birthYear, 2008);
});

test('rejects an invalid birthYear or sex', async () => {
  for (const body of [{ birthYear: 1899 }, { birthYear: 1990.5 }, { birthYear: 'abc' }, { sex: 'other' }]) {
    assert.equal((await client.put('/api/settings', body)).status, 400, JSON.stringify(body));
  }
});

test('rejects unknown microTargets keys', async () => {
  const unknown = await client.put('/api/settings', { microTargets: { vitaminZ: 5 } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /vitaminZ/);
  // retinol is internal and not a user-facing target.
  assert.equal((await client.put('/api/settings', { microTargets: { retinol: 5 } })).status, 400);
});

test('rejects microTargets that are not positive finite numbers within range', async () => {
  const bad = [{ iron: 0 }, { iron: -1 }, { iron: 'abc' }, { iron: null }, { iron: 1e9 }, [], 'iron'];
  for (const microTargets of bad) {
    assert.equal((await client.put('/api/settings', { microTargets })).status, 400, JSON.stringify(microTargets));
  }
});

test('null clears sex and birthYear', async () => {
  await client.put('/api/settings', { sex: 'male', birthYear: 1980 });
  const res = await client.put('/api/settings', { sex: null, birthYear: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.sex, null);
  assert.equal(res.body.birthYear, null);
});

test('omitting profile fields leaves them untouched', async () => {
  await client.put('/api/settings', { sex: 'male', birthYear: 1980 });
  const res = await client.put('/api/settings', { proteinTarget: 100 });
  assert.equal(res.body.sex, 'male');
  assert.equal(res.body.birthYear, 1980);
});
