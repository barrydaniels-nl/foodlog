import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';
import { ESTIMATE_SCHEMA, parseEstimate } from '../server/food-estimate.js';
import { OpenAiError } from '../server/openai.js';

const VALID = { recognised: true, kcal: 62.4, protein: 11.26, carbs: 3.5, fat: 0.2, fiber: 0, portionLabel: null, portionGrams: null };
const VALUES = { kcal: 62, protein: 11.3, carbs: 3.5, fat: 0.2, fiber: 0 };
const URL_PATH = '/api/ingredients/estimate';

let server;
let client;
let calls;

/** Fake OpenAI client: records requests and answers with `answer()`, throwing an Error result. */
function fakeOpenAi(answer = () => VALID) {
  calls = [];
  return {
    generateJson: async (request) => {
      calls.push(request);
      const value = answer();
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

async function start(openAi) {
  server = await startTestServer({ openAi });
  client = api(server.url);
}

beforeEach((t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
});
afterEach(() => server?.close());

test('parseEstimate rounds like the rest of the app and drops the flag', () => {
  assert.deepEqual(parseEstimate(VALID), { ...VALUES, portion: null });
});

test('parseEstimate returns null for a food the model does not recognise', () => {
  assert.equal(parseEstimate({ ...VALID, recognised: false }), null);
});

for (const [label, raw] of [
  ['no answer', null],
  ['a missing flag', { kcal: 1, protein: 1, carbs: 1, fat: 1, fiber: 1 }],
  ['a missing value', { ...VALID, fat: undefined }],
  ['a negative value', { ...VALID, protein: -1 }],
  ['kcal above the ingredient limit', { ...VALID, kcal: 1001 }],
  ['a macro above 100 g', { ...VALID, carbs: 100.1 }],
]) {
  test(`parseEstimate rejects ${label}`, () => {
    assert.throws(() => parseEstimate(raw), OpenAiError);
  });
}

test('parseEstimate returns one average item, with whole grams and a trimmed label', () => {
  const { portion } = parseEstimate({ ...VALID, portionLabel: ' 1 onion ', portionGrams: 109.6 });
  assert.deepEqual(portion, { label: '1 onion', grams: 110 });
});

for (const [label, portionLabel, portionGrams] of [
  ['a label without grams', '1 onion', null],
  ['grams without a label', null, 110],
  ['a blank label', '  ', 110],
  ['a label longer than a portion allows', 'x'.repeat(41), 110],
  ['less than a gram', '1 grain', 0.4],
  ['more than a portion allows', '1 pumpkin', 5001],
]) {
  test(`parseEstimate drops only the portion for ${label}`, () => {
    assert.deepEqual(parseEstimate({ ...VALID, portionLabel, portionGrams }), { ...VALUES, portion: null });
  });
}

test('the schema asks for every nutrient, as strict structured output requires', () => {
  assert.deepEqual([...ESTIMATE_SCHEMA.required].sort(), Object.keys(ESTIMATE_SCHEMA.properties).sort());
});

test('estimate returns the values per 100 g and sends only name and brand', async () => {
  await start(fakeOpenAi());
  const { status, body } = await client.post(URL_PATH, { name: ' Magere kwark ', brand: 'Arla', kcal: 5 });
  assert.equal(status, 200);
  assert.deepEqual(body, { ...VALUES, portion: null });
  assert.deepEqual(JSON.parse(calls[0].input), { name: 'Magere kwark', brand: 'Arla' });
});

test('an estimated portion is accepted when saved with the food', async () => {
  await start(fakeOpenAi(() => ({ ...VALID, portionLabel: '1 ui', portionGrams: 110 })));
  const { body } = await client.post(URL_PATH, { name: 'Ui' });
  assert.deepEqual(body.portion, { label: '1 ui', grams: 110 });
  const saved = await client.post('/api/ingredients', { name: 'Ui', ...VALUES, portions: [body.portion] });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.portions[0].grams, 110);
});

test('estimate stores nothing', async () => {
  await start(fakeOpenAi());
  await client.post(URL_PATH, { name: 'Kwark' });
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ingredients').get().n, 0);
});

test('estimate needs a name and does not call OpenAI without one', async () => {
  await start(fakeOpenAi());
  const { status } = await client.post(URL_PATH, { name: '  ' });
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test('estimate answers 503 without an OpenAI key', async () => {
  await start(null);
  const { status, body } = await client.post(URL_PATH, { name: 'Kwark' });
  assert.equal(status, 503);
  assert.match(body.error, /OPENAI_API_KEY/);
});

test('estimate answers 422 for an unrecognised food', async () => {
  await start(fakeOpenAi(() => ({ ...VALID, recognised: false })));
  const { status, body } = await client.post(URL_PATH, { name: 'asdf' });
  assert.equal(status, 422);
  assert.match(body.error, /recognise/);
});

for (const [label, answer] of [
  ['OpenAI fails', () => new OpenAiError('secret detail')],
  ['the answer is unusable', () => ({ ...VALID, kcal: 5000 })],
]) {
  test(`estimate answers 502 without internals when ${label}`, async () => {
    await start(fakeOpenAi(answer));
    const { status, body } = await client.post(URL_PATH, { name: 'Kwark' });
    assert.equal(status, 502);
    assert.equal(body.error, "Couldn't look up this food right now. Try again in a moment.");
  });
}
