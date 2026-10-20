import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';

let server;
let client;

const SKYR = {
  name: 'Skyr naturel',
  brand: 'Arla',
  barcode: '5711953068881',
  kcal: 63,
  protein: 11,
  carbs: 4,
  fat: 0.2,
  portions: [{ label: '1 pot', grams: 150 }],
};

beforeEach(async () => {
  server = await startTestServer({ today: '2026-10-21' });
  client = api(server.url);
});
afterEach(() => server.close());

function insertEntry(date, ingredientId, kcal) {
  server.db
    .prepare(
      `INSERT INTO entries (date, slot, ingredient_id, name, grams, kcal, protein, carbs, fat, fiber, position)
       VALUES (?, 'breakfast', ?, 'Skyr naturel', 150, ?, 11, 4, 0.2, 0, 0)`,
    )
    .run(date, ingredientId, kcal);
}

test('create and get round-trip including portions', async () => {
  const created = await client.post('/api/ingredients', SKYR);
  assert.equal(created.status, 201);
  assert.equal(created.body.fiber, 0);
  assert.equal(created.body.source, 'manual');
  assert.equal(created.body.archived, false);
  const fetched = await client.get(`/api/ingredients/${created.body.id}`);
  assert.equal(fetched.body.name, 'Skyr naturel');
  assert.deepEqual(
    fetched.body.portions.map(({ label, grams }) => ({ label, grams })),
    [{ label: '1 pot', grams: 150 }],
  );
});

test('search is case-insensitive and ranks name-prefix matches first', async () => {
  await client.post('/api/ingredients', { ...SKYR, name: 'Icelandic skyr', barcode: null });
  await client.post('/api/ingredients', SKYR);
  await client.post('/api/ingredients', { ...SKYR, name: 'Oats', barcode: null, brand: null });
  const res = await client.get('/api/ingredients?q=sky');
  assert.deepEqual(
    res.body.map((i) => i.name),
    ['Skyr naturel', 'Icelandic skyr'],
  );
});

test('search also matches brand', async () => {
  await client.post('/api/ingredients', SKYR);
  const res = await client.get('/api/ingredients?q=arla');
  assert.equal(res.body.length, 1);
});

test('archived ingredients are hidden from the list but still resolvable', async () => {
  const { body } = await client.post('/api/ingredients', SKYR);
  assert.equal((await client.del(`/api/ingredients/${body.id}`)).status, 204);
  assert.equal((await client.get('/api/ingredients')).body.length, 0);
  assert.equal((await client.get('/api/ingredients?archived=1')).body.length, 1);
  assert.equal((await client.get(`/api/ingredients/${body.id}`)).body.archived, true);
  const byBarcode = await client.get(`/api/ingredients/barcode/${SKYR.barcode}`);
  assert.equal(byBarcode.status, 200);
  assert.equal(byBarcode.body.archived, true);

  const restored = await client.post(`/api/ingredients/${body.id}/restore`);
  assert.equal(restored.body.archived, false);
  assert.equal((await client.get('/api/ingredients')).body.length, 1);
});

test('unknown barcode lookup is 404', async () => {
  assert.equal((await client.get('/api/ingredients/barcode/12345678')).status, 404);
});

test('duplicate barcode is a 409 that names the existing ingredient', async () => {
  const first = await client.post('/api/ingredients', SKYR);
  const second = await client.post('/api/ingredients', SKYR);
  assert.equal(second.status, 409);
  assert.equal(second.body.existingId, first.body.id);
});

test('out-of-range nutrient is a 400 naming the field', async () => {
  const res = await client.post('/api/ingredients', { ...SKYR, protein: 120 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /protein/);
});

test('invalid barcode is rejected', async () => {
  const res = await client.post('/api/ingredients', { ...SKYR, barcode: 'abc' });
  assert.equal(res.status, 400);
});

test('update replaces portions', async () => {
  const { body } = await client.post('/api/ingredients', SKYR);
  const res = await client.put(`/api/ingredients/${body.id}`, { ...SKYR, portions: [{ label: 'Bowl', grams: 200 }] });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.portions.map((p) => p.label),
    ['Bowl'],
  );
});

test('update refreshes entries from today onward and leaves past days alone', async () => {
  const { body } = await client.post('/api/ingredients', { ...SKYR, kcal: 100 });
  insertEntry('2026-10-20', body.id, 100);
  insertEntry('2026-10-21', body.id, 100);
  insertEntry('2026-10-22', body.id, 100);
  await client.put(`/api/ingredients/${body.id}`, { ...SKYR, kcal: 120 });
  const rows = server.db.prepare('SELECT date, kcal FROM entries ORDER BY date').all();
  assert.deepEqual(
    rows.map((r) => [r.date, r.kcal]),
    [
      ['2026-10-20', 100],
      ['2026-10-21', 120],
      ['2026-10-22', 120],
    ],
  );
});

test('unknown ingredient id is 404', async () => {
  assert.equal((await client.get('/api/ingredients/999')).status, 404);
  assert.equal((await client.put('/api/ingredients/999', SKYR)).status, 404);
});

test('recent lists the most recently planned ingredients first, without duplicates or archived ones', async () => {
  const oats = (await client.post('/api/ingredients', { name: 'Oats', kcal: 380, protein: 13, carbs: 60, fat: 7 })).body;
  const skyr = (await client.post('/api/ingredients', { ...SKYR })).body;
  const rice = (await client.post('/api/ingredients', { name: 'Rice', kcal: 350, protein: 8, carbs: 78, fat: 1 })).body;
  const unused = (await client.post('/api/ingredients', { name: 'Unused', kcal: 1, protein: 1, carbs: 1, fat: 1 })).body;
  for (const id of [oats.id, skyr.id, oats.id, rice.id]) {
    await client.post('/api/days/2026-10-21/entries', { slot: 'lunch', ingredientId: id, grams: 10 });
  }
  await client.del(`/api/ingredients/${rice.id}`);
  const res = await client.get('/api/ingredients?recent=1');
  assert.deepEqual(
    res.body.map((i) => i.name),
    ['Oats', 'Skyr naturel'],
  );
  assert.ok(!res.body.some((i) => i.id === unused.id));
});
