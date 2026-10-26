import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, api } from './helpers.js';
import { createReferenceRepo } from '../server/nevo.js';
import { createFoodMicrosRepo, validateMicroValues } from '../server/food-micros.js';

const SAMPLE = readFileSync(new URL('./fixtures/nevo-sample.csv', import.meta.url), 'utf8');

let server;
let client;
let foodMicros;

beforeEach(async () => {
  server = await startTestServer({ today: '2026-10-21' });
  client = api(server.url);
  foodMicros = createFoodMicrosRepo(server.db, { reference: createReferenceRepo(server.db) });
  await client.post('/api/reference/nevo', { csv: SAMPLE });
});
afterEach(() => server.close());

async function createFood(overrides = {}) {
  const res = await client.post('/api/ingredients', { name: 'Granola', kcal: 450, protein: 10, carbs: 60, fat: 15, ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const adopt = async (code) => (await client.post(`/api/reference/nevo/${code}/adopt`)).body;
const microInfo = async (id) => (await client.get(`/api/ingredients/${id}/micros`)).body;
const attempts = (id) => server.db.prepare('SELECT micro_attempts FROM ingredients WHERE id = ?').get(id).micro_attempts;
const nameOf = (id) => server.db.prepare('SELECT name FROM ingredients WHERE id = ?').get(id)?.name ?? null;
/** The guard the matcher passes: the food's job, twin and name as they are now. */
function expected(id) {
  const { job, twinCode } = foodMicros.info(id);
  return { expectJob: job, expectTwinCode: twinCode, expectName: nameOf(id) };
}
const finish = (id, result) => foodMicros.finishJob(id, { ...expected(id), ...result });
const fail = (id) => foodMicros.failJob(id, expected(id));

test('adopting a NEVO food makes it its own confirmed twin with a fill job', async () => {
  const egg = await adopt(9001);
  assert.deepEqual(egg.micro, { twinCode: 'nevo:9001', status: 'confirmed' });
  assert.deepEqual(await microInfo(egg.id), {
    twinCode: 'nevo:9001',
    twinName: 'Ei testkip rauw',
    status: 'confirmed',
    job: 'fill',
    label: {},
    ai: {},
  });
});

test('a new manual food is pending with a match job', async () => {
  const food = await createFood();
  assert.deepEqual(food.micro, { twinCode: null, status: 'pending' });
  const info = await microInfo(food.id);
  assert.equal(info.job, 'match');
  assert.equal(info.twinName, null);
});

test('resolve prefers label over twin over ai', async () => {
  const egg = await adopt(9001);
  const plain = await createFood();
  finish(egg.id, { status: 'confirmed', aiValues: { iron: 9, vitaminD: 7, thiamin: 0.5 } });
  foodMicros.writeLabelValues(egg.id, { iron: 3 });

  const resolved = foodMicros.resolve([egg.id, plain.id, egg.id, 999]);
  assert.deepEqual([...resolved.keys()].sort(), [egg.id, plain.id].sort(), 'duplicates collapse, unknown ids are left out');
  const { values, retinol, hasData, twinCode, status } = resolved.get(egg.id);
  assert.deepEqual(values.iron, { amount: 3, origin: 'label' });
  assert.deepEqual(values.vitaminD, { amount: 2.5, origin: 'nevo' });
  assert.deepEqual(values.thiamin, { amount: 0.5, origin: 'ai' });
  assert.equal('vitaminK' in values, false, 'unknown everywhere stays absent');
  assert.equal('retinol' in values, false, 'retinol is internal');
  assert.equal(retinol, 180);
  assert.equal(hasData, true);
  assert.equal(twinCode, 'nevo:9001');
  assert.equal(status, 'confirmed');

  assert.deepEqual(resolved.get(plain.id), { status: 'pending', twinCode: null, values: {}, retinol: null, hasData: false });
  assert.equal(foodMicros.resolve([]).size, 0);
});

test('resolve falls through to ai when the twin is blank', async () => {
  const food = await createFood();
  foodMicros.setTwin(food.id, 9002);
  finish(food.id, { status: 'confirmed', aiValues: { iodine: 2 } });
  const { values, retinol } = foodMicros.resolve([food.id]).get(food.id);
  assert.deepEqual(values.iodine, { amount: 2, origin: 'ai' });
  assert.deepEqual(values.vitaminC, { amount: 45, origin: 'nevo' });
  assert.equal(retinol, null, 'the twin has no retinol value');
});

test('setTwin clears ai values and queues a fill', async () => {
  const food = await createFood();
  finish(food.id, { twinCode: 'nevo:9001', status: 'unconfirmed', aiValues: { thiamin: 0.1 } });
  fail(food.id);

  const res = await client.put(`/api/ingredients/${food.id}/micros/twin`, { code: 9002 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    twinCode: 'nevo:9002',
    twinName: 'Paksoi test rauw',
    status: 'confirmed',
    job: 'fill',
    label: {},
    ai: {},
  });
  assert.equal(attempts(food.id), 0);

  const none = (await client.put(`/api/ingredients/${food.id}/micros/twin`, { code: null })).body;
  assert.equal(none.twinCode, null);
  assert.equal(none.job, 'fill');
  assert.equal((await client.put(`/api/ingredients/${food.id}/micros/twin`, { code: 12345 })).status, 404);
  assert.equal((await client.put(`/api/ingredients/${food.id}/micros/twin`, {})).status, 400);
  assert.equal((await client.put('/api/ingredients/999/micros/twin', { code: 9001 })).status, 404);
});

test('setTwin to no twin keeps the ai estimates and queues a fill for the gaps', async () => {
  const food = await createFood();
  finish(food.id, { status: 'unconfirmed', aiValues: { thiamin: 0.1, iodine: 5 } });

  const none = (await client.put(`/api/ingredients/${food.id}/micros/twin`, { code: null })).body;
  assert.deepEqual(
    { twinCode: none.twinCode, status: none.status, job: none.job, ai: none.ai },
    { twinCode: null, status: 'confirmed', job: 'fill', ai: { thiamin: 0.1, iodine: 5 } },
  );
  assert.equal(foodMicros.listForReview().some((row) => row.id === food.id), false, 'confirmed with data leaves the review');

  const twin = (await client.put(`/api/ingredients/${food.id}/micros/twin`, { code: 9002 })).body;
  assert.deepEqual(twin.ai, {}, 'estimates made without a twin do not fit a new one');
});

test('saveValues stores label values and drops the ai row for that key', async () => {
  const food = await createFood();
  finish(food.id, { status: 'unconfirmed', aiValues: { thiamin: 0.1, iodine: 5 } });
  const res = await client.put(`/api/ingredients/${food.id}/micros/values`, { values: { thiamin: 0.2 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.label, { thiamin: 0.2 });
  assert.deepEqual(res.body.ai, { iodine: 5 });
  // A second edit adds to the label values instead of replacing them.
  const again = (await client.put(`/api/ingredients/${food.id}/micros/values`, { values: { iodine: 6 } })).body;
  assert.deepEqual(again.label, { thiamin: 0.2, iodine: 6 });
  assert.deepEqual(again.ai, {});
});

test('rejects unknown keys and values above max with 400', async () => {
  const food = await createFood();
  const put = (values) => client.put(`/api/ingredients/${food.id}/micros/values`, { values });
  assert.equal((await put({ vitaminZ: 1 })).status, 400);
  assert.equal((await put({ retinol: 1 })).status, 400, 'retinol only comes from NEVO');
  assert.equal((await put({ iron: 400.1 })).status, 400);
  assert.equal((await put({ iron: -1 })).status, 400);
  assert.equal((await put({ iron: 'lots' })).status, 400);
  assert.equal((await put([1])).status, 400);
  assert.equal((await put(undefined)).status, 400);
  assert.equal((await put({ iron: 400, salt: 97.5 })).status, 200, 'the maximum itself is allowed');
  assert.equal((await client.post('/api/ingredients', { name: 'X', kcal: 1, protein: 0, carbs: 0, fat: 0, micros: { iron: 1000 } })).status, 400);

  assert.deepEqual(validateMicroValues({ iron: 5000 }, 'nutrients', { maxFor: () => 100000 }), { iron: 5000 });
});

test('queue lists waiting foods with their macros, oldest first', async () => {
  const first = await createFood({ name: 'Oats', brand: 'Quaker' });
  await adopt(9001);
  const done = await createFood({ name: 'Done' });
  const gone = await createFood({ name: 'Gone' });
  finish(done.id, { status: 'none', aiValues: {} });
  await client.del(`/api/ingredients/${gone.id}`);

  const queue = foodMicros.queue(10);
  assert.deepEqual(queue.map((food) => food.name), ['Oats', 'Ei testkip rauw']);
  assert.deepEqual(queue[0], {
    id: first.id, name: 'Oats', brand: 'Quaker', kcal: 450, protein: 10, carbs: 60, fat: 15,
    job: 'match', twinCode: null, status: 'pending',
  });
  assert.equal(queue[1].job, 'fill');
  assert.equal(foodMicros.queue(1).length, 1);
});

test('finishJob keeps the twin when none is given and replaces only the given ai keys', async () => {
  const egg = await adopt(9001);
  finish(egg.id, { status: 'confirmed', aiValues: { thiamin: 0.1, vitaminK: 2 } });
  fail(egg.id);
  finish(egg.id, { status: 'confirmed', aiValues: { thiamin: 0.3 } });
  const info = foodMicros.info(egg.id);
  assert.equal(info.twinCode, 'nevo:9001');
  assert.equal(info.job, null);
  assert.deepEqual(info.ai, { thiamin: 0.3, vitaminK: 2 });
  assert.equal(attempts(egg.id), 0);

  finish(egg.id, { twinCode: null, status: 'unconfirmed', aiValues: {} });
  assert.equal(foodMicros.info(egg.id).twinCode, null);
});

test('finishJob and failJob write nothing when the job or twin changed', async () => {
  const food = await createFood();
  const queued = { expectJob: 'match', expectTwinCode: null, expectName: 'Granola' };
  const result = { twinCode: 'nevo:9001', status: 'unconfirmed', aiValues: { thiamin: 0.1 } };

  assert.equal(foodMicros.finishJob(food.id, { ...queued, expectJob: 'fill', ...result }), false);
  assert.equal(foodMicros.finishJob(food.id, { ...queued, expectTwinCode: 'nevo:9002', ...result }), false);
  assert.equal(foodMicros.failJob(food.id, { ...queued, expectJob: 'fill' }), false);
  assert.equal(foodMicros.failJob(999, { ...queued, expectName: 'Granola' }), false, 'a missing food is not counted and does not throw');
  assert.deepEqual(await microInfo(food.id), {
    twinCode: null, twinName: null, status: 'pending', job: 'match', label: {}, ai: {},
  });
  assert.equal(attempts(food.id), 0);

  await client.del(`/api/ingredients/${food.id}`);
  assert.equal(foodMicros.finishJob(food.id, { ...queued, ...result }), false, 'an archived food is left alone');
  assert.equal(foodMicros.failJob(food.id, queued), false);
  assert.equal((await microInfo(food.id)).job, 'match');
});

test('finishJob and failJob write nothing when the name changed, e.g. an import reused the id', async () => {
  const food = await createFood();
  const queued = expected(food.id);
  await client.put(`/api/ingredients/${food.id}`, { ...food, name: 'Muesli' });

  const result = { twinCode: 'nevo:9001', status: 'unconfirmed', aiValues: { thiamin: 0.1 } };
  assert.equal(foodMicros.finishJob(food.id, { ...queued, ...result }), false);
  assert.equal(foodMicros.failJob(food.id, queued), false);
  assert.deepEqual(await microInfo(food.id), {
    twinCode: null, twinName: null, status: 'pending', job: 'match', label: {}, ai: {},
  });
  assert.equal(attempts(food.id), 0);
  assert.equal(foodMicros.finishJob(food.id, { ...expected(food.id), ...result }), true, 'the current name is accepted');
});

test('finishJob keeps the status when none is given and never adds ai rows for labelled keys', async () => {
  const egg = await adopt(9001);
  assert.equal(finish(egg.id, { aiValues: {} }), true);
  assert.deepEqual({ status: foodMicros.info(egg.id).status, job: foodMicros.info(egg.id).job }, { status: 'confirmed', job: null });

  const food = await createFood({ micros: { thiamin: 0.2 } });
  finish(food.id, { twinCode: 'nevo:9002', status: 'unconfirmed', aiValues: { thiamin: 0.1, vitaminK: 2 } });
  assert.deepEqual(foodMicros.info(food.id).ai, { vitaminK: 2 });
  assert.deepEqual(foodMicros.listForReview().find((row) => row.id === food.id).aiKeys, ['vitaminK']);
});

test('failJob marks a food without data as none after 3 attempts', async () => {
  const empty = await createFood({ name: 'Empty' });
  const labelled = await createFood({ name: 'Labelled', micros: { calcium: 120 } });
  for (let i = 0; i < 2; i += 1) {
    fail(empty.id);
    fail(labelled.id);
  }
  assert.deepEqual(foodMicros.queue(10).map((food) => food.id), [empty.id, labelled.id], 'still retried before the limit');
  fail(empty.id);
  fail(labelled.id);

  assert.deepEqual(foodMicros.queue(10), []);
  assert.deepEqual({ status: foodMicros.info(empty.id).status, job: foodMicros.info(empty.id).job }, { status: 'none', job: null });
  assert.deepEqual(
    { status: foodMicros.info(labelled.id).status, job: foodMicros.info(labelled.id).job },
    { status: 'pending', job: null },
    'a food with its own values is not "no data"',
  );
});

test('confirm approves an AI match and leaves other statuses alone', async () => {
  const matched = await createFood({ name: 'Matched' });
  const waiting = await createFood({ name: 'Waiting' });
  finish(matched.id, { twinCode: 'nevo:9002', status: 'unconfirmed', aiValues: {} });
  assert.equal((await client.post(`/api/ingredients/${matched.id}/micros/confirm`)).body.status, 'confirmed');
  assert.equal((await client.post(`/api/ingredients/${waiting.id}/micros/confirm`)).body.status, 'pending');
  assert.equal((await client.post('/api/ingredients/999/micros/confirm')).status, 404);
});

test('listForReview leaves out confirmed and archived foods', async () => {
  await adopt(9001);
  const pending = await createFood({ name: 'Pending', brand: 'Brand' });
  const matched = await createFood({ name: 'Matched' });
  const archived = await createFood({ name: 'Archived' });
  finish(matched.id, { twinCode: 'nevo:9002', status: 'unconfirmed', aiValues: { iodine: 5, vitaminA: 3 } });
  await client.del(`/api/ingredients/${archived.id}`);

  const res = await client.get('/api/micros/review');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    { id: matched.id, name: 'Matched', brand: null, status: 'unconfirmed', twinCode: 'nevo:9002', twinName: 'Paksoi test rauw', aiKeys: ['vitaminA', 'iodine'] },
    { id: pending.id, name: 'Pending', brand: 'Brand', status: 'pending', twinCode: null, twinName: null, aiKeys: [] },
  ]);
});

test('listForReview keeps any food without data, whatever its status', async () => {
  const empty = await createFood({ name: 'Empty' });
  const labelled = await createFood({ name: 'Labelled', micros: { calcium: 120 } });
  await client.put(`/api/ingredients/${empty.id}/micros/twin`, { code: null });
  await client.put(`/api/ingredients/${labelled.id}/micros/twin`, { code: null });

  const listed = foodMicros.listForReview().map((row) => [row.name, row.status]);
  assert.deepEqual(listed, [['Empty', 'confirmed']], 'a confirmed food with no data is still listed; one with data is not');
  assert.equal(foodMicros.resolve([empty.id]).get(empty.id).hasData, false);
});

test('creating with micros stores label values; updating without micros keeps them', async () => {
  const food = await createFood({ micros: { calcium: 120, vitaminD: 1.5 } });
  assert.deepEqual((await microInfo(food.id)).label, { vitaminD: 1.5, calcium: 120 });

  assert.equal((await client.put(`/api/ingredients/${food.id}`, { ...food, kcal: 460 })).status, 200);
  assert.deepEqual((await microInfo(food.id)).label, { vitaminD: 1.5, calcium: 120 });

  await client.put(`/api/ingredients/${food.id}`, { ...food, micros: { calcium: 100 } });
  assert.deepEqual((await microInfo(food.id)).label, { calcium: 100 }, 'present micros replace all label values');
});

test("editing a NEVO food's macros keeps its twin", async () => {
  const egg = await adopt(9001);
  const changed = (await client.put(`/api/ingredients/${egg.id}`, { ...egg, kcal: 140 })).body;
  assert.equal(changed.referenceCode, null);
  assert.equal(changed.source, 'manual');
  assert.deepEqual(changed.micro, { twinCode: 'nevo:9001', status: 'confirmed' });
});
