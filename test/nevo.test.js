import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { startTestServer, api } from './helpers.js';
import { parseNevoCsv } from '../server/nevo.js';

const SAMPLE = readFileSync(new URL('./fixtures/nevo-sample.csv', import.meta.url), 'utf8');
const REAL_FILE = new URL('../nevo/NEVO2025_v9.0.csv', import.meta.url);

let server;
let client;

beforeEach(async () => {
  server = await startTestServer({ today: '2026-10-21' });
  client = api(server.url);
});
afterEach(() => server.close());

const importSample = () => client.post('/api/reference/nevo', { csv: SAMPLE });

test('parseNevoCsv reads version, names and per-100 g values with decimal commas', () => {
  const { version, foods } = parseNevoCsv(SAMPLE);
  assert.equal(version, '2025/9.0');
  assert.equal(foods.length, 3);
  assert.deepEqual(foods[0], {
    code: 9001,
    name: 'Ei testkip rauw',
    nameEn: 'Egg test chicken raw',
    synonym: 'Testeieren rauw',
    group: 'Eggs',
    per: '100g',
    kcal: 130,
    protein: 12.5,
    carbs: 0.5,
    fat: 9,
    fiber: 0,
  });
});

test('parseNevoCsv treats a blank fibre value as 0 and keeps per 100 ml', () => {
  const { foods } = parseNevoCsv(SAMPLE);
  assert.equal(foods[1].fiber, 0);
  assert.equal(foods[2].per, '100ml');
});

test('parseNevoCsv rejects a file that is not the NEVO dataset', () => {
  assert.throws(() => parseNevoCsv('name;kcal\negg;130'), (err) => err.status === 400 && /NEVO/.test(err.message));
});

test('the real NEVO file parses completely', { skip: !existsSync(REAL_FILE) && 'NEVO file not present' }, () => {
  const { version, foods } = parseNevoCsv(readFileSync(REAL_FILE, 'utf8'));
  assert.equal(version, '2025/9.0');
  assert.equal(foods.length, 2328);
  const egg = foods.find((f) => f.code === 83);
  assert.equal(egg.name, 'Ei kippen- rauw gem');
  assert.equal(egg.kcal, 132);
  assert.equal(egg.protein, 12.3);
});

test('status is empty before an import', async () => {
  assert.deepEqual((await client.get('/api/reference/status')).body, { nevo: null });
  assert.deepEqual((await client.get('/api/reference/search?q=ei')).body, []);
});

test('import stores the dataset and reports its status; re-import replaces it', async () => {
  const res = await importSample();
  assert.equal(res.status, 200);
  assert.equal(res.body.version, '2025/9.0');
  assert.equal(res.body.count, 3);
  await importSample();
  const status = (await client.get('/api/reference/status')).body.nevo;
  assert.equal(status.count, 3);
  assert.equal(status.version, '2025/9.0');
  assert.equal(status.credit, 'Based on data from NEVO online version 2025/9.0, RIVM, Bilthoven and other data sources');
});

test('import of a non-NEVO file is a 400 and keeps the previous dataset', async () => {
  await importSample();
  const res = await client.post('/api/reference/nevo', { csv: 'not,a,nevo,file' });
  assert.equal(res.status, 400);
  assert.equal((await client.get('/api/reference/status')).body.nevo.count, 3);
});

test('search matches Dutch name, English name and synonym, prefix matches first', async () => {
  await importSample();
  const names = async (q) => (await client.get(`/api/reference/search?q=${q}`)).body.map((f) => f.name);
  assert.deepEqual(await names('paksoi'), ['Paksoi test rauw']);
  assert.deepEqual(await names('egg'), ['Ei testkip rauw']);
  assert.deepEqual(await names('testeieren'), ['Ei testkip rauw']);
  assert.deepEqual((await names('test')).slice(0, 1), ['Testsap sinaasappel']);
});

test('adopting a NEVO food copies it unchanged into your foods, once', async () => {
  await importSample();
  const first = await client.post('/api/reference/nevo/9001/adopt');
  assert.equal(first.status, 200);
  assert.equal(first.body.name, 'Ei testkip rauw');
  assert.equal(first.body.source, 'nevo');
  assert.equal(first.body.referenceCode, 'nevo:9001');
  assert.equal(first.body.protein, 12.5);
  const again = await client.post('/api/reference/nevo/9001/adopt');
  assert.equal(again.body.id, first.body.id);
});

test('adopting a food you deleted restores it', async () => {
  await importSample();
  const first = (await client.post('/api/reference/nevo/9001/adopt')).body;
  await client.del(`/api/ingredients/${first.id}`);
  const again = (await client.post('/api/reference/nevo/9001/adopt')).body;
  assert.equal(again.id, first.id);
  assert.equal(again.archived, false);
});

test('search leaves out NEVO foods that are already in your foods', async () => {
  await importSample();
  await client.post('/api/reference/nevo/9001/adopt');
  assert.deepEqual((await client.get('/api/reference/search?q=egg')).body, []);
});

test('unknown NEVO code is 404', async () => {
  await importSample();
  assert.equal((await client.post('/api/reference/nevo/12345/adopt')).status, 404);
});

test('changing a NEVO food’s values turns it into your own food; renaming keeps the link', async () => {
  await importSample();
  const egg = (await client.post('/api/reference/nevo/9001/adopt')).body;
  const renamed = (await client.put(`/api/ingredients/${egg.id}`, { ...egg, name: 'Ei', portions: [{ label: '1 egg', grams: 55 }] })).body;
  assert.equal(renamed.source, 'nevo');
  assert.equal(renamed.referenceCode, 'nevo:9001');
  const changed = (await client.put(`/api/ingredients/${egg.id}`, { ...renamed, kcal: 140 })).body;
  assert.equal(changed.source, 'manual');
  assert.equal(changed.referenceCode, null);
});

test('backups keep the NEVO link of your foods', async () => {
  await importSample();
  await client.post('/api/reference/nevo/9001/adopt');
  const backup = (await client.get('/api/export')).body;
  assert.equal(backup.ingredients[0].referenceCode, 'nevo:9001');
  assert.equal((await client.post('/api/import', backup)).status, 200);
  assert.equal((await client.get('/api/ingredients')).body[0].referenceCode, 'nevo:9001');
});
