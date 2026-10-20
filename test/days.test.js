import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';

let server;
let client;
let oats;
let skyr;

beforeEach(async () => {
  server = await startTestServer({ today: '2026-10-21' });
  client = api(server.url);
  oats = (await client.post('/api/ingredients', { name: 'Oats', kcal: 380, protein: 13, carbs: 60, fat: 7, fiber: 10 })).body;
  skyr = (await client.post('/api/ingredients', { name: 'Skyr', kcal: 63, protein: 11, carbs: 4, fat: 0.2 })).body;
});
afterEach(() => server.close());

const addEntry = (date, body) => client.post(`/api/days/${date}/entries`, body);

test('an empty day has every slot, zero totals and the targets', async () => {
  const res = await client.get('/api/days/2026-10-21');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.slots), ['breakfast', 'lunch', 'dinner', 'snacks']);
  assert.equal(res.body.totals.kcal, 0);
  assert.deepEqual(res.body.slots.lunch.entries, []);
  assert.deepEqual(res.body.targets, { kcal: 2000, protein: 120 });
});

test('targets follow settings', async () => {
  await client.put('/api/settings', { kcalTarget: 2200, proteinTarget: 160 });
  assert.deepEqual((await client.get('/api/days/2026-10-21')).body.targets, { kcal: 2200, protein: 160 });
});

test('adding an entry returns the updated day', async () => {
  const res = await addEntry('2026-10-21', { slot: 'breakfast', ingredientId: oats.id, grams: 60 });
  assert.equal(res.status, 201);
  const [entry] = res.body.slots.breakfast.entries;
  assert.equal(entry.name, 'Oats');
  assert.equal(entry.grams, 60);
  assert.equal(entry.nutrients.kcal, 228);
  assert.equal(entry.per100.kcal, 380);
  assert.equal(res.body.slots.breakfast.totals.kcal, 228);
  assert.equal(res.body.totals.kcal, 228);
});

test('entries keep their insertion order within a slot', async () => {
  await addEntry('2026-10-21', { slot: 'breakfast', ingredientId: oats.id, grams: 60 });
  const res = await addEntry('2026-10-21', { slot: 'breakfast', ingredientId: skyr.id, grams: 150 });
  assert.deepEqual(
    res.body.slots.breakfast.entries.map((e) => e.name),
    ['Oats', 'Skyr'],
  );
});

test('adding a saved meal with a scale inserts scaled entries', async () => {
  const meal = (
    await client.post('/api/meals', {
      name: 'Usual breakfast',
      items: [
        { ingredientId: oats.id, grams: 60 },
        { ingredientId: skyr.id, grams: 150 },
      ],
    })
  ).body;
  const res = await client.post('/api/days/2026-10-21/meals', { slot: 'breakfast', mealId: meal.id, scale: 1.5 });
  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.slots.breakfast.entries.map((e) => e.grams),
    [90, 225],
  );
});

test('scale outside 0.25–10 is rejected', async () => {
  const meal = (await client.post('/api/meals', { name: 'M', items: [{ ingredientId: oats.id, grams: 60 }] })).body;
  const res = await client.post('/api/days/2026-10-21/meals', { slot: 'breakfast', mealId: meal.id, scale: 20 });
  assert.equal(res.status, 400);
});

test('PATCH changes grams and moves the entry to another slot', async () => {
  const day = (await addEntry('2026-10-21', { slot: 'breakfast', ingredientId: oats.id, grams: 60 })).body;
  const id = day.slots.breakfast.entries[0].id;
  const res = await client.patch(`/api/entries/${id}`, { grams: 80, slot: 'snacks' });
  assert.equal(res.status, 200);
  assert.equal(res.body.slots.breakfast.entries.length, 0);
  assert.equal(res.body.slots.snacks.entries[0].grams, 80);
});

test('DELETE removes the entry and returns the day', async () => {
  const day = (await addEntry('2026-10-21', { slot: 'lunch', ingredientId: oats.id, grams: 60 })).body;
  const res = await client.del(`/api/entries/${day.slots.lunch.entries[0].id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.kcal, 0);
});

test('copy day duplicates entries using current ingredient values', async () => {
  await addEntry('2026-10-20', { slot: 'lunch', ingredientId: oats.id, grams: 60 });
  await client.put(`/api/ingredients/${oats.id}`, { name: 'Oats', kcal: 400, protein: 13, carbs: 60, fat: 7, fiber: 10 });
  const res = await client.post('/api/days/2026-10-21/copy', { fromDate: '2026-10-20' });
  assert.equal(res.status, 200);
  const [copied] = res.body.slots.lunch.entries;
  assert.equal(copied.grams, 60);
  assert.equal(copied.per100.kcal, 400);
  const source = (await client.get('/api/days/2026-10-20')).body.slots.lunch.entries[0];
  assert.equal(source.per100.kcal, 380);
});

test('copy from an empty day or onto itself is a 400', async () => {
  assert.equal((await client.post('/api/days/2026-10-21/copy', { fromDate: '2026-10-19' })).body.error, 'Nothing planned on that day');
  assert.equal((await client.post('/api/days/2026-10-21/copy', { fromDate: '2026-10-21' })).status, 400);
});

test('invalid date and slot are 400', async () => {
  assert.equal((await client.get('/api/days/2026-13-01')).status, 400);
  assert.equal((await addEntry('2026-10-21', { slot: 'brunch', ingredientId: oats.id, grams: 60 })).status, 400);
});

test('unknown ingredient, meal and entry are 404', async () => {
  assert.equal((await addEntry('2026-10-21', { slot: 'lunch', ingredientId: 999, grams: 60 })).status, 404);
  assert.equal((await client.post('/api/days/2026-10-21/meals', { slot: 'lunch', mealId: 999 })).status, 404);
  assert.equal((await client.patch('/api/entries/999', { grams: 10 })).status, 404);
});
