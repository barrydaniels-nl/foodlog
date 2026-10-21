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
  oats = (await client.post('/api/ingredients', { name: 'Oats', kcal: 380, protein: 13, carbs: 60, fat: 7, fiber: 10 }))
    .body;
  skyr = (await client.post('/api/ingredients', { name: 'Skyr', brand: 'Arla', kcal: 60, protein: 11, carbs: 4, fat: 0.2 }))
    .body;
  await client.put('/api/settings', { kcalTarget: 500, proteinTarget: 30 });
});
afterEach(() => server?.close());

const plan = (date, slot, ingredient, grams) =>
  client.post(`/api/days/${date}/entries`, { slot, ingredientId: ingredient.id, grams });

test('GET /api/diet returns Markdown with no-store caching', async () => {
  const response = await client.get('/api/diet');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.body, /^# Food diary: 2026-09-22 to 2026-10-21$/m);
  assert.match(response.body, /Covers the last 30 days/);
});

test('lists days newest first, ending today, and leaves out future plans', async () => {
  await plan('2026-10-22', 'breakfast', oats, 60);
  const { body } = await client.get('/api/diet?days=3');
  const headings = body.match(/^## \d{4}-\d{2}-\d{2}.*$/gm);
  assert.deepEqual(headings, [
    '## 2026-10-21 · Wednesday 21 Oct (today, may be incomplete)',
    '## 2026-10-20 · Tuesday 20 Oct',
    '## 2026-10-19 · Monday 19 Oct',
  ]);
  assert.doesNotMatch(body, /2026-10-22/);
});

test('shows foods per meal with totals against targets', async () => {
  await plan('2026-10-20', 'breakfast', oats, 60);
  await plan('2026-10-20', 'snacks', skyr, 150);
  const { body } = await client.get('/api/diet?days=2');
  assert.match(body, /Total: 318 \/ 500 kcal · 24\.3 \/ 30 g protein · 42 g carbs · 4\.5 g fat · 6 g fibre/);
  assert.match(body, /### Breakfast \(228 kcal · 7\.8 g protein\)\n- Oats, 60 g: 228 kcal · 7\.8 g protein · 36 g carbs/);
  assert.match(body, /### Snacks \(90 kcal · 16\.5 g protein\)\n- Skyr \(Arla\), 150 g: 90 kcal/);
  assert.doesNotMatch(body, /### Lunch/);
});

test('marks empty days as nothing logged', async () => {
  const { body } = await client.get('/api/diet?days=2');
  assert.match(body, /## 2026-10-20 · Tuesday 20 Oct\n\nNothing logged\./);
  assert.match(body, /Days with food logged: 0 of 2/);
  assert.match(body, /No completed days with food logged/);
});

test('summary averages completed logged days and leaves out today', async () => {
  await plan('2026-10-19', 'breakfast', oats, 200); // 760 kcal, 26 g protein: over kcal, under protein
  await plan('2026-10-20', 'breakfast', skyr, 300); // 180 kcal, 33 g protein: within both
  await plan('2026-10-21', 'breakfast', oats, 500); // today, excluded from the averages
  const { body } = await client.get('/api/diet?days=7');
  assert.match(body, /Days with food logged: 3 of 7/);
  assert.match(body, /Average per logged day \(excluding today\): 470 kcal · 29\.5 g protein/);
  assert.match(body, /Over the kcal target: 1 of 2 days/);
  assert.match(body, /Under the protein target: 1 of 2 days/);
  assert.match(body, /current settings \(no history is kept\): 500 kcal and 30 g protein/);
});

for (const [query, message] of [
  ['days=0', 'days must be between 1 and 365'],
  ['days=366', 'days must be between 1 and 365'],
  ['days=2.5', 'days must be a whole number'],
  ['days=abc', 'days must be a number'],
  ['days=', 'days must be a number'],
]) {
  test(`rejects ${query}`, async () => {
    const response = await client.get(`/api/diet?${query}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, message);
  });
}

test('is read-only', async () => {
  const response = await client.post('/api/diet', {});
  assert.equal(response.status, 404);
});
