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

test('returns defaults when nothing is stored', async () => {
  const res = await client.get('/api/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { kcalTarget: 2000, proteinTarget: 120, offCountry: 'nl' });
});

test('PUT persists a partial update and keeps other fields', async () => {
  const res = await client.put('/api/settings', { kcalTarget: 2200 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { kcalTarget: 2200, proteinTarget: 120, offCountry: 'nl' });
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
