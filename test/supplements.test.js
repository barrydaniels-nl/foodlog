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

const makeSupplement = async (overrides = {}) =>
  (
    await client.post('/api/supplements', {
      name: 'Vitamin D3',
      brand: 'Acme',
      unitLabel: 'capsule',
      nutrients: { vitaminD: 25 },
      ...overrides,
    })
  ).body;

test('creates, lists, updates and archives a supplement', async () => {
  const created = await client.post('/api/supplements', {
    name: ' Multi ',
    unitLabel: 'tablet',
    nutrients: { folate: 200, vitaminC: 80 },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, {
    id: created.body.id,
    name: 'Multi',
    brand: null,
    unitLabel: 'tablet',
    archived: false,
    nutrients: { folate: 200, vitaminC: 80 },
  });

  const updated = await client.put(`/api/supplements/${created.body.id}`, {
    name: 'Multi',
    brand: 'Acme',
    unitLabel: 'tablet',
    nutrients: { vitaminC: 100000 },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.nutrients, { vitaminC: 100000 });
  assert.equal(updated.body.brand, 'Acme');

  const tooMuch = await client.put(`/api/supplements/${created.body.id}`, {
    name: 'Multi',
    unitLabel: 'tablet',
    nutrients: { vitaminC: 100001 },
  });
  assert.equal(tooMuch.status, 400);

  assert.equal((await client.del(`/api/supplements/${created.body.id}`)).status, 204);
  assert.deepEqual((await client.get('/api/supplements')).body, []);
  const all = await client.get('/api/supplements?archived=1');
  assert.deepEqual(
    all.body.map((s) => [s.name, s.archived]),
    [['Multi', true]],
  );

  const restored = await client.post(`/api/supplements/${created.body.id}/restore`);
  assert.equal(restored.body.archived, false);
  assert.equal((await client.get('/api/supplements')).body.length, 1);
  assert.equal((await client.get('/api/supplements/9999')).status, 404);
});

test('requires at least one nutrient', async () => {
  const base = { name: 'Empty', unitLabel: 'capsule' };
  for (const nutrients of [{}, undefined, [], { notANutrient: 1 }, { vitaminC: -1 }]) {
    const res = await client.post('/api/supplements', { ...base, nutrients });
    assert.equal(res.status, 400, JSON.stringify(nutrients));
  }
  const noUnit = await client.post('/api/supplements', { name: 'X', nutrients: { vitaminC: 1 } });
  assert.equal(noUnit.status, 400);
});

test('puts the daily set and adds it to a day in order', async () => {
  const d3 = await makeSupplement();
  const fish = await makeSupplement({ name: 'Fish oil', nutrients: { epaDha: 500 } });

  const put = await client.put('/api/supplement-set', {
    items: [
      { supplementId: fish.id, units: 2 },
      { supplementId: d3.id, units: 1 },
    ],
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, [
    { supplementId: fish.id, name: 'Fish oil', unitLabel: 'capsule', units: 2 },
    { supplementId: d3.id, name: 'Vitamin D3', unitLabel: 'capsule', units: 1 },
  ]);
  assert.deepEqual((await client.get('/api/supplement-set')).body, put.body);

  const added = await client.post('/api/days/2026-10-21/supplements/set');
  assert.equal(added.status, 201);
  assert.deepEqual(
    added.body.map((e) => [e.name, e.units, e.position, e.unitLabel, e.brand]),
    [
      ['Fish oil', 2, 0, 'capsule', 'Acme'],
      ['Vitamin D3', 1, 1, 'capsule', 'Acme'],
    ],
  );

  // Adding again duplicates; the user removes duplicates, as with meals.
  const again = await client.post('/api/days/2026-10-21/supplements/set');
  assert.equal(again.body.length, 4);

  const duplicate = await client.put('/api/supplement-set', {
    items: [
      { supplementId: d3.id, units: 1 },
      { supplementId: d3.id, units: 2 },
    ],
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await client.put('/api/supplement-set', { items: [{ supplementId: 9999, units: 1 }] })).status, 400);
  assert.equal((await client.put('/api/supplement-set', { items: [{ supplementId: d3.id, units: 0 }] })).status, 400);
  assert.equal((await client.get('/api/supplement-set')).body.length, 2);
});

test('rejects adding an empty set to a day', async () => {
  const res = await client.post('/api/days/2026-10-21/supplements/set');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Your daily supplements set is empty');
});

test('copies supplements from another day', async () => {
  const d3 = await makeSupplement();
  const fish = await makeSupplement({ name: 'Fish oil', nutrients: { epaDha: 500 } });
  await client.post('/api/days/2026-10-20/supplements', { supplementId: d3.id, units: 1.5 });
  await client.post('/api/days/2026-10-20/supplements', { supplementId: fish.id, units: 2 });
  await client.del(`/api/supplements/${fish.id}`);

  const res = await client.post('/api/days/2026-10-21/supplements/copy', { fromDate: '2026-10-20' });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((e) => [e.date, e.name, e.units]),
    [
      ['2026-10-21', 'Vitamin D3', 1.5],
      ['2026-10-21', 'Fish oil', 2],
    ],
  );

  const empty = await client.post('/api/days/2026-10-21/supplements/copy', { fromDate: '2026-10-01' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'Nothing planned on that day');
});

test('rejects copying from the same day', async () => {
  const res = await client.post('/api/days/2026-10-21/supplements/copy', { fromDate: '2026-10-21' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Pick a different day to copy from');
});

test('rejects adding an archived supplement', async () => {
  const d3 = await makeSupplement();
  await client.del(`/api/supplements/${d3.id}`);
  const archived = await client.post('/api/days/2026-10-21/supplements', { supplementId: d3.id, units: 1 });
  assert.equal(archived.status, 400);
  assert.match(archived.body.error, /Vitamin D3/);
  const missing = await client.post('/api/days/2026-10-21/supplements', { supplementId: 9999, units: 1 });
  assert.equal(missing.status, 404);
});

test('keeps an archived supplement in the set but skips it when adding the set', async () => {
  const d3 = await makeSupplement();
  const fish = await makeSupplement({ name: 'Fish oil', nutrients: { epaDha: 500 } });
  const items = [
    { supplementId: d3.id, units: 1 },
    { supplementId: fish.id, units: 1 },
  ];
  await client.put('/api/supplement-set', { items });
  await client.del(`/api/supplements/${d3.id}`);

  assert.equal((await client.get('/api/supplement-set')).body.length, 2);
  assert.equal((await client.put('/api/supplement-set', { items })).status, 200);
  const added = await client.post('/api/days/2026-10-21/supplements/set');
  assert.deepEqual(
    added.body.map((e) => e.name),
    ['Fish oil'],
  );

  // Dropped from the set, an archived supplement cannot be put back.
  await client.put('/api/supplement-set', { items: [{ supplementId: fish.id, units: 1 }] });
  assert.equal((await client.put('/api/supplement-set', { items })).status, 400);
});

test('updates units and removes an entry', async () => {
  const d3 = await makeSupplement();
  const added = await client.post('/api/days/2026-10-21/supplements', { supplementId: d3.id, units: 1 });
  assert.equal(added.status, 201);
  const [entry] = added.body;

  const updated = await client.patch(`/api/supplement-entries/${entry.id}`, { units: 2.5 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body[0].units, 2.5);

  for (const units of [0.2, 21, 'lots']) {
    assert.equal((await client.patch(`/api/supplement-entries/${entry.id}`, { units })).status, 400);
  }
  assert.equal((await client.patch('/api/supplement-entries/9999', { units: 1 })).status, 404);

  const removed = await client.del(`/api/supplement-entries/${entry.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, []);
});

test('exposes raw per-unit amounts and ranges to other modules', async () => {
  const d3 = await makeSupplement();
  await client.post('/api/days/2026-10-21/supplements', { supplementId: d3.id, units: 1 });
  await client.post('/api/days/2026-10-23/supplements', { supplementId: d3.id, units: 2 });
  const { createSupplementsRepo } = await import('../server/supplements.js');
  const repo = createSupplementsRepo(server.db);

  assert.deepEqual(repo.nutrientsFor([d3.id, 777]), new Map([[d3.id, { vitaminD: 25 }], [777, {}]]));
  assert.deepEqual(
    repo.entriesForRange('2026-10-21', '2026-10-22').map((e) => e.date),
    ['2026-10-21'],
  );
  assert.equal(repo.entriesForRange('2026-10-01', '2026-10-31').length, 2);
});
