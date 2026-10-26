import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestServer, api } from './helpers.js';
import { openDb } from '../server/db.js';
import { parseNevoCsv, createReferenceRepo } from '../server/nevo.js';

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
    micros: {
      vitaminA: 190,
      folate: 47,
      vitaminD: 2.5,
      iron: 1.8,
      iodine: 45,
      potassium: 130,
      salt: 0.25,
      epaDha: 750,
      retinol: 180,
    },
  });
});

test('parseNevoCsv reads micronutrients and derives salt and EPA+DHA', () => {
  const { foods, hasMicros } = parseNevoCsv(SAMPLE);
  assert.equal(hasMicros, true);
  const { micros } = foods[0];
  assert.equal(micros.vitaminD, 2.5);
  assert.equal(micros.iodine, 45);
  assert.equal(micros.iron, 1.8);
  assert.equal(micros.retinol, 180);
  assert.equal(micros.salt, 0.25, '100 mg sodium is 0.25 g salt');
  assert.equal(micros.epaDha, 750, '0.25 g EPA + 0.5 g DHA is 750 mg');
  assert.equal(micros.folate, 47, '30 µg natural + 10 µg folic acid x 1.7');
  assert.equal('thiamin' in micros, false, 'a blank cell is unknown, not 0');
});

test('a file without micronutrient columns still imports, with has_micros off', async () => {
  const header = [
    'NEVO-versie/NEVO-version', 'Food group', 'NEVO-code', 'Voedingsmiddelnaam/Dutch food name', 'Engelse naam/Food name',
    'Synoniem', 'Hoeveelheid/Quantity', 'ENERCC (kcal)', 'PROT (g)', 'CHO (g)', 'FAT (g)', 'FIBT (g)',
  ].join('|');
  const csv = `${header}\nNEVO-Online 2025 9.0|Eggs|9001|Ei|Egg||per 100g|130|12,5|0,5|9|0\n`;
  assert.deepEqual(parseNevoCsv(csv).foods[0].micros, {});
  assert.equal(parseNevoCsv(csv).hasMicros, false);
  assert.equal((await client.post('/api/reference/nevo', { csv })).body.hasMicros, false);
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

test('blank micronutrient columns store no row', async () => {
  await importSample();
  const reference = createReferenceRepo(server.db);
  assert.equal('iodine' in reference.getMicros(9002), false);
  assert.equal(reference.getMicros(9002).vitaminC, 45);
  assert.equal(reference.getMicros(9001).iodine, 45);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM reference_micros WHERE amount = 0").get().n, 0);
});

test('status reports hasMicros after an import with micronutrient columns', async () => {
  const reference = createReferenceRepo(server.db);
  assert.equal(reference.hasMicros(), false);
  await importSample();
  assert.equal((await client.get('/api/reference/status')).body.nevo.hasMicros, true);
  assert.equal(reference.hasMicros(), true);
});

test('re-importing replaces the micronutrient rows', async () => {
  await importSample();
  await importSample();
  const reference = createReferenceRepo(server.db);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM reference_micros WHERE code = 9001').get().n, Object.keys(reference.getMicros(9001)).length);
});

test('migration 3 links existing NEVO foods as confirmed twins with a fill job', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'foodlog-migrate-')), 'old.db');
  const old = openDb(file, { targetVersion: 2 });
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 2);
  const insert = old.prepare(
    "INSERT INTO ingredients (name, kcal, protein, carbs, fat, source, reference_code) VALUES (?, 130, 12, 1, 9, ?, ?)",
  );
  insert.run('Egg', 'nevo', 'nevo:9001');
  insert.run('Homemade granola', 'manual', null);
  old.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  const row = (name) => db.prepare('SELECT micro_twin_code, micro_status, micro_job, micro_attempts FROM ingredients WHERE name = ?').get(name);
  assert.deepEqual({ ...row('Egg') }, { micro_twin_code: 'nevo:9001', micro_status: 'confirmed', micro_job: 'fill', micro_attempts: 0 });
  assert.deepEqual({ ...row('Homemade granola') }, { micro_twin_code: null, micro_status: 'pending', micro_job: 'match', micro_attempts: 0 });
  db.close();
});

test('search with all=1 includes adopted foods', async () => {
  await importSample();
  await client.post('/api/reference/nevo/9001/adopt');
  assert.deepEqual((await client.get('/api/reference/search?q=egg')).body, []);
  const all = (await client.get('/api/reference/search?q=egg&all=1')).body;
  assert.deepEqual(all.map((f) => f.code), [9001]);
});

test('searchCandidates matches any term in name, English name or synonym, once each, adopted or not', async () => {
  await importSample();
  await client.post('/api/reference/nevo/9001/adopt');
  const reference = createReferenceRepo(server.db);
  const found = reference.searchCandidates(['egg', 'testeieren', 'paksoi', '  '], 10);
  assert.deepEqual(found.map((f) => f.code).sort(), [9001, 9002]);
  assert.deepEqual(found.find((f) => f.code === 9001), {
    code: 9001, name: 'Ei testkip rauw', nameEn: 'Egg test chicken raw', group: 'Eggs', kcal: 130, protein: 12.5, carbs: 0.5, fat: 9,
  });
  assert.equal(reference.searchCandidates(['test'], 2).length, 2);
  assert.deepEqual(reference.searchCandidates([], 10), []);
  assert.deepEqual(reference.searchCandidates(['100%'], 10), [], 'wildcards are matched literally');
});
