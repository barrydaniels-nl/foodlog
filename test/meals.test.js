import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';

let server;
let client;
let oats;
let skyr;

beforeEach(async () => {
  server = await startTestServer();
  client = api(server.url);
  oats = (await client.post('/api/ingredients', { name: 'Oats', kcal: 380, protein: 13, carbs: 60, fat: 7, fiber: 10 })).body;
  skyr = (await client.post('/api/ingredients', { name: 'Skyr', kcal: 63, protein: 11, carbs: 4, fat: 0.2 })).body;
});
afterEach(() => server.close());

const usualBreakfast = () => ({
  name: 'Usual breakfast',
  items: [
    { ingredientId: oats.id, grams: 60 },
    { ingredientId: skyr.id, grams: 150 },
  ],
});

test('create computes item nutrients and rounded totals', async () => {
  const res = await client.post('/api/meals', usualBreakfast());
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Usual breakfast');
  assert.deepEqual(
    res.body.items.map((i) => [i.name, i.grams, i.nutrients.kcal]),
    [
      ['Oats', 60, 228],
      ['Skyr', 150, 95],
    ],
  );
  assert.equal(res.body.totals.kcal, 323);
  assert.equal(res.body.totals.protein, 24.3);
});

test('list returns meals with totals', async () => {
  await client.post('/api/meals', usualBreakfast());
  const res = await client.get('/api/meals');
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].totals.kcal, 323);
});

test('update replaces items', async () => {
  const { body } = await client.post('/api/meals', usualBreakfast());
  const res = await client.put(`/api/meals/${body.id}`, { name: 'Light', items: [{ ingredientId: skyr.id, grams: 200 }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Light');
  assert.deepEqual(
    res.body.items.map((i) => i.grams),
    [200],
  );
});

test('delete removes the meal', async () => {
  const { body } = await client.post('/api/meals', usualBreakfast());
  assert.equal((await client.del(`/api/meals/${body.id}`)).status, 204);
  assert.equal((await client.get(`/api/meals/${body.id}`)).status, 404);
});

test('a meal keeps working when one of its ingredients is archived', async () => {
  const { body } = await client.post('/api/meals', usualBreakfast());
  await client.del(`/api/ingredients/${oats.id}`);
  const res = await client.get(`/api/meals/${body.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].archived, true);
  const kept = await client.put(`/api/meals/${body.id}`, usualBreakfast());
  assert.equal(kept.status, 200);
});

test('an archived ingredient cannot be newly added', async () => {
  await client.del(`/api/ingredients/${oats.id}`);
  const res = await client.post('/api/meals', usualBreakfast());
  assert.equal(res.status, 400);
});

test('unknown ingredient is rejected', async () => {
  const res = await client.post('/api/meals', { name: 'X', items: [{ ingredientId: 999, grams: 10 }] });
  assert.equal(res.status, 400);
});

test('a meal needs a name and at least one item', async () => {
  assert.equal((await client.post('/api/meals', { name: '', items: usualBreakfast().items })).status, 400);
  assert.equal((await client.post('/api/meals', { name: 'Empty', items: [] })).status, 400);
});

test('createFromSlot builds a meal from a planned slot in order', async () => {
  const insert = server.db.prepare(
    `INSERT INTO entries (date, slot, ingredient_id, name, grams, kcal, protein, carbs, fat, fiber, position)
     VALUES ('2026-10-21', 'breakfast', ?, 'x', ?, 0, 0, 0, 0, 0, ?)`,
  );
  insert.run(skyr.id, 150, 1);
  insert.run(oats.id, 60, 0);
  const res = await client.post('/api/meals/from-slot', { date: '2026-10-21', slot: 'breakfast', name: 'Saved' });
  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.items.map((i) => [i.name, i.grams]),
    [
      ['Oats', 60],
      ['Skyr', 150],
    ],
  );
});

test('createFromSlot on an empty slot is a 400', async () => {
  const res = await client.post('/api/meals/from-slot', { date: '2026-10-21', slot: 'lunch', name: 'Saved' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Nothing to save in this meal');
});
