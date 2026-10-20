import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startTestServer, api } from './helpers.js';

let server;
let client;

async function seed(target) {
  await target.put('/api/settings', { kcalTarget: 2200 });
  const oats = (
    await target.post('/api/ingredients', {
      name: 'Oats',
      barcode: '87654321',
      kcal: 380,
      protein: 13,
      carbs: 60,
      fat: 7,
      portions: [{ label: 'Scoop', grams: 40 }],
    })
  ).body;
  const old = (await target.post('/api/ingredients', { name: 'Old thing', kcal: 100, protein: 1, carbs: 1, fat: 1 })).body;
  await target.del(`/api/ingredients/${old.id}`);
  await target.post('/api/meals', { name: 'Porridge', items: [{ ingredientId: oats.id, grams: 60 }] });
  await target.post('/api/days/2026-10-21/entries', { slot: 'breakfast', ingredientId: oats.id, grams: 60 });
}

beforeEach(async () => {
  server = await startTestServer({ today: '2026-10-21' });
  client = api(server.url);
});
afterEach(() => server.close());

test('export downloads a dated attachment', async () => {
  await seed(client);
  const res = await client.get('/api/export');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="foodlog-2026-10-21.json"');
  assert.equal(res.body.app, 'foodlog');
  assert.equal(res.body.version, 1);
  assert.equal(res.body.ingredients.length, 2);
});

test('export then import into a fresh server restores everything', async () => {
  await seed(client);
  const backup = (await client.get('/api/export')).body;

  const fresh = await startTestServer({ today: '2026-10-21' });
  try {
    const other = api(fresh.url);
    await other.post('/api/ingredients', { name: 'Will be replaced', kcal: 1, protein: 1, carbs: 1, fat: 1 });
    const res = await other.post('/api/import', backup);
    assert.equal(res.status, 200);
    assert.equal(res.body.ingredients, 2);
    assert.equal(res.body.meals, 1);
    assert.equal(res.body.entries, 1);

    assert.deepEqual((await other.get('/api/days/2026-10-21')).body, (await client.get('/api/days/2026-10-21')).body);
    assert.deepEqual((await other.get('/api/meals')).body, (await client.get('/api/meals')).body);
    assert.deepEqual((await other.get('/api/settings')).body, (await client.get('/api/settings')).body);
    assert.deepEqual(
      (await other.get('/api/ingredients?archived=1')).body,
      (await client.get('/api/ingredients?archived=1')).body,
    );
  } finally {
    await fresh.close();
  }
});

test('a foreign file is rejected and existing data is untouched', async () => {
  await seed(client);
  const res = await client.post('/api/import', { app: 'other', version: 1 });
  assert.equal(res.status, 400);
  assert.equal((await client.get('/api/ingredients')).body.length, 1);
});

test('a malformed row is rejected before anything is deleted', async () => {
  await seed(client);
  const backup = (await client.get('/api/export')).body;
  delete backup.entries[0].grams;
  const res = await client.post('/api/import', backup);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /entries\[0\]\.grams/);
  assert.equal((await client.get('/api/days/2026-10-21')).body.totals.kcal, 228);
});

test('an import whose rows reference missing ingredients is rejected and rolled back', async () => {
  await seed(client);
  const backup = (await client.get('/api/export')).body;
  backup.entries[0].ingredientId = 999;
  const res = await client.post('/api/import', backup);
  assert.equal(res.status, 400);
  assert.equal((await client.get('/api/days/2026-10-21')).body.totals.kcal, 228);
});

test('import saves a server-side snapshot of the data it replaces', async () => {
  await seed(client);
  const backup = (await client.get('/api/export')).body;
  backup.ingredients = backup.ingredients.filter((i) => i.archived);
  backup.meals = [];
  backup.entries = [];
  const res = await client.post('/api/import', backup);
  assert.equal(res.status, 200);
  const files = readdirSync(server.backupDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^pre-import-.*\.json$/);
  assert.equal(res.body.snapshot, files[0]);
  const snapshot = JSON.parse(readFileSync(path.join(server.backupDir, files[0]), 'utf8'));
  assert.equal(snapshot.ingredients.length, 2);
  assert.equal(snapshot.entries.length, 1);
});

test('a rejected import writes no snapshot', async () => {
  await seed(client);
  await client.post('/api/import', { app: 'other' });
  assert.equal(existsSync(server.backupDir) ? readdirSync(server.backupDir).length : 0, 0);
});
