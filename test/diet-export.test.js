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

test('diet report lists supplements per day and a micronutrient table', async () => {
  await client.put('/api/settings', { sex: 'female', birthYear: 1990 });
  const d3 = (
    await client.post('/api/supplements', {
      name: 'Vitamin D 25 µg',
      unitLabel: 'tablet',
      nutrients: { vitaminD: 25 },
    })
  ).body;
  const mag = (
    await client.post('/api/supplements', { name: 'Magnesium', unitLabel: 'capsule', nutrients: { magnesium: 100 } })
  ).body;
  await plan('2026-10-20', 'breakfast', oats, 60);
  await client.post('/api/days/2026-10-20/supplements', { supplementId: d3.id, units: 1 });
  await client.post('/api/days/2026-10-20/supplements', { supplementId: mag.id, units: 2.5 });
  await client.post('/api/days/2026-10-19/supplements', { supplementId: mag.id, units: 1 });

  const { body } = await client.get('/api/diet?days=3');
  assert.match(body, /^Profile: female, 36$/m);
  assert.match(body, /^Micronutrients use the current best values per food, not snapshots; "≈" marks values that are more than 25% estimated\.$/m);
  assert.match(body, /^Amounts are lower bounds where foods lack data: "Without data" is the grams of food per day with no value for that nutrient\.$/m);
  assert.match(body, /^## Micronutrients \(average per completed day\)$/m);
  assert.match(
    body,
    /^\| Nutrient \| Food \| Supplements \| Total \| Recommended \| % \| Upper limit \| Days below 66% \| Estimated \| Without data \|$/m,
  );
  const vitaminD = body.match(/^\| Vitamin D \|.*$/m)[0];
  assert.match(vitaminD, /^\| Vitamin D \| 0 µg \| 25 µg \| 25 µg \| 10 µg \| 250% \| 100 µg \| 0 \/ 1 \| 0% \| 60 g \|$/, 'the oats have no data');
  assert.match(body, /^\| Salt \|.*\| — \| — \| 6 g \| 0 \/ 1 \|/m);
  assert.equal(body.match(/^\| [A-Z].*$/gm).length, 1 + 23, 'header plus one row per nutrient');
  assert.match(body, /^Supplements: Vitamin D 25 µg × 1 tablet, Magnesium × 2\.5 capsule$/m);
  assert.match(body, /## 2026-10-19 .*\n\nNothing logged\.\nSupplements: Magnesium × 1 capsule/);
  assert.equal(body.match(/^Supplements:/gm).length, 2);
});

test('diet report marks a value above the upper limit', async () => {
  await client.put('/api/settings', { sex: 'female', birthYear: 1990 });
  const d3 = (await client.post('/api/supplements', { name: 'Mega D', unitLabel: 'tablet', nutrients: { vitaminD: 150 } })).body;
  await plan('2026-10-20', 'breakfast', oats, 60);
  await client.post('/api/days/2026-10-20/supplements', { supplementId: d3.id, units: 1 });
  const { body } = await client.get('/api/diet?days=2');
  assert.match(body.match(/^\| Vitamin D \|.*$/m)[0], /\| ⚠ 100 µg \| 0 \/ 1 \|/);
});

test('diet report shows the amount a non-total upper limit was compared with, and — when all food has data', async () => {
  await client.put('/api/settings', { sex: 'female', birthYear: 1990 });
  const known = (
    await client.post('/api/ingredients', { name: 'Known', kcal: 50, protein: 1, carbs: 10, fat: 0, micros: { magnesium: 10 } })
  ).body;
  const mag = (await client.post('/api/supplements', { name: 'Magnesium', unitLabel: 'capsule', nutrients: { magnesium: 300 } })).body;
  const vitA = (await client.post('/api/supplements', { name: 'Vitamin A', unitLabel: 'tablet', nutrients: { vitaminA: 1200 } })).body;
  await plan('2026-10-20', 'breakfast', known, 100);
  await client.post('/api/days/2026-10-20/supplements', { supplementId: mag.id, units: 1 });
  await client.post('/api/days/2026-10-20/supplements', { supplementId: vitA.id, units: 1 });

  const { body } = await client.get('/api/diet?days=2');
  const rowFor = (label) => body.match(new RegExp(`^\\| ${label} \\|.*$`, 'm'))[0];
  assert.match(rowFor('Magnesium'), /\| ⚠ 250 mg \(supplements: 300 mg\) \| 0 \/ 1 \| 0% \| — \|$/, 'food magnesium is left out');
  assert.match(rowFor('Vitamin A'), /\| 3000 µg \(retinol: 1200 µg\) \| 0 \/ 1 \| 0% \| 100 g \|$/);
  assert.match(rowFor('Iron'), /\| 1 \/ 1 \| 0% \| 100 g \|$/);
});

test('diet report shows profile not set', async () => {
  await plan('2026-10-20', 'breakfast', oats, 60);
  const { body } = await client.get('/api/diet?days=2');
  assert.match(body, /^Profile: not set$/m);
  const row = body.match(/^\| Vitamin D \|.*$/m)[0];
  assert.match(row, /\| — \| — \| — \| 0 \/ 1 \|/);
  assert.doesNotMatch(body, /^Supplements:/m);
});

test('diet report replaces the micronutrient table when no day is completed', async () => {
  const { body } = await client.get('/api/diet?days=2');
  assert.match(body, /## Micronutrients \(average per completed day\)\n\n- No completed days with food logged in this period\./);
  assert.doesNotMatch(body, /\| Nutrient \|/);
});

test('is read-only', async () => {
  const response = await client.post('/api/diet', {});
  assert.equal(response.status, 404);
});
