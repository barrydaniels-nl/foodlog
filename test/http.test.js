import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { startTestServer, api } from './helpers.js';
import { createRouter } from '../server/router.js';
import { openDb } from '../server/db.js';

let server;
let client;

before(async () => {
  server = await startTestServer();
  client = api(server.url);
});
after(() => server.close());

test('GET /api/health returns ok', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('unknown api path returns 404 json', async () => {
  const res = await client.get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});

test('GET / serves index.html', async () => {
  const res = await fetch(server.url + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('path traversal is refused', async () => {
  const res = await fetch(server.url + '/%2e%2e/package.json');
  assert.equal(res.status, 404);
});

test('broken JSON body is rejected with 400', async () => {
  const router = createRouter();
  router.add('POST', '/api/things', () => ({ ok: true }));
  const req = Object.assign(Readable.from([Buffer.from('{not json')]), {
    method: 'POST',
    url: '/api/things',
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(router.handle(req, {}), (err) => err.status === 400 && err.message === 'Invalid JSON body');
});

test('router extracts params and query', async () => {
  const router = createRouter();
  let seen;
  router.add('GET', '/api/things/:id', (ctx) => {
    seen = ctx;
    return { ok: true };
  });
  const req = { method: 'GET', url: '/api/things/42?x=1', headers: {} };
  const res = { writeHead() {}, end() {} };
  const handled = await router.handle(req, res);
  assert.equal(handled, true);
  assert.equal(seen.params.id, '42');
  assert.equal(seen.query.get('x'), '1');
});

test('router returns false for unmatched paths', async () => {
  const router = createRouter();
  const handled = await router.handle({ method: 'GET', url: '/x', headers: {} }, {});
  assert.equal(handled, false);
});

test('openDb migrates and enforces slot check', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.prepare("INSERT INTO ingredients (name, kcal, protein, carbs, fat) VALUES ('Oats', 380, 13, 60, 7)").run();
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO entries (date, slot, ingredient_id, name, grams, kcal, protein, carbs, fat, fiber, position)
         VALUES ('2026-10-21', 'brunch', 1, 'Oats', 60, 380, 13, 60, 7, 0, 0)`,
      )
      .run(),
  );
  db.close();
});

test('barcode scanner library is served locally', async () => {
  const wasm = await fetch(server.url + '/vendor/zxing_reader.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  const script = await fetch(server.url + '/vendor/barcode-detector.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(await script.text(), /BarcodeDetectionAPI/);
});

test('a non-JSON request body is refused with 415', async () => {
  const res = await fetch(server.url + '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ kcalTarget: 2500 }),
  });
  assert.equal(res.status, 415);
  assert.equal((await client.get('/api/settings')).body.kcalTarget, 2000);
});

test('cross-site writes are refused with 403', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const res = await client.post('/api/import', { app: 'foodlog' }, { 'sec-fetch-site': site });
    assert.equal(res.status, 403, site);
  }
});

test('same-origin writes are allowed', async () => {
  const res = await client.post('/api/ingredients', { name: 'X', kcal: 1, protein: 1, carbs: 1, fat: 1 }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 201);
});
