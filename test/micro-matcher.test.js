import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startTestServer, api } from './helpers.js';
import { createReferenceRepo } from '../server/nevo.js';
import { createFoodMicrosRepo } from '../server/food-micros.js';
import { createMicroMatcher, parseEstimates } from '../server/micro-matcher.js';
import { OpenAiError, OpenAiErrorKind } from '../server/openai.js';
import { MICRO_KEYS } from '../public/js/shared/micronutrients.js';

const SAMPLE = readFileSync(new URL('./fixtures/nevo-sample.csv', import.meta.url), 'utf8');

let server;
let client;
let reference;
let foodMicros;
let calls;
let warn;

/**
 * Fake OpenAI client answering by request name. An answer may be a value, a
 * function of the request, or an Error to throw.
 * @param {Record<string, unknown>} answers
 */
function fakeOpenAi(answers) {
  calls = [];
  return {
    generateJson: async (request) => {
      calls.push({ ...request, input: JSON.parse(request.input) });
      const answer = answers[request.name];
      const value = typeof answer === 'function' ? await answer(request) : answer;
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected request ${request.name}`);
      return value;
    },
  };
}

const matcherWith = (answers, options = {}) =>
  createMicroMatcher({ db: server.db, openAi: fakeOpenAi(answers), reference, foodMicros, ...options });

/** Estimates every asked-for nutrient as 1 (in its unit). */
const estimateAll = (request) => ({
  values: request.schema.properties.values.items.properties.key.enum.map((key) => ({ key, amount: 1 })),
});
const askedKeys = (call) => call.schema.properties.values.items.properties.key.enum;
const callsNamed = (name) => calls.filter((call) => call.name === name);
const row = (id) =>
  server.db.prepare('SELECT micro_twin_code, micro_status, micro_job, micro_attempts FROM ingredients WHERE id = ?').get(id);

beforeEach(async (t) => {
  t.mock.method(console, 'error', () => {});
  warn = t.mock.method(console, 'warn', () => {});
  server = await startTestServer({ today: '2026-10-21' });
  client = api(server.url);
  reference = createReferenceRepo(server.db);
  foodMicros = createFoodMicrosRepo(server.db, { reference });
});
afterEach(() => server.close());

const uploadNevo = () => client.post('/api/reference/nevo', { csv: SAMPLE });

async function createFood(overrides = {}) {
  const res = await client.post('/api/ingredients', {
    name: 'Scharreleieren',
    brand: 'Boer Jan',
    kcal: 140,
    protein: 12,
    carbs: 1,
    fat: 10,
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('matcher idles until NEVO has micronutrients', async () => {
  const food = await createFood();
  const matcher = matcherWith({});
  assert.equal(await matcher.runOnce(), 0);
  assert.equal(calls.length, 0);
  assert.deepEqual({ ...row(food.id) }, { micro_twin_code: null, micro_status: 'pending', micro_job: 'match', micro_attempts: 0 });
});

test('matches a twin and fills the twin\'s blanks with ai values', async () => {
  await uploadNevo();
  const food = await createFood({ micros: { thiamin: 0.1 } });
  const matcher = matcherWith({
    micro_search_terms: { terms: ['ei', 'egg'] },
    micro_twin: { code: 9001 },
    micro_estimate: estimateAll,
  });

  assert.equal(await matcher.runOnce(), 1);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['micro_search_terms', 'micro_twin', 'micro_estimate'],
  );
  assert.equal(callsNamed('micro_twin')[0].input.candidates.some((c) => c.code === 9001), true);

  const twinValues = reference.getMicros(9001);
  const gaps = MICRO_KEYS.filter((key) => key !== 'thiamin' && !(key in twinValues));
  assert.ok(gaps.length > 0 && gaps.length < MICRO_KEYS.length);
  assert.deepEqual(askedKeys(callsNamed('micro_estimate')[0]), gaps, 'label and twin values are not asked for');
  assert.deepEqual(
    callsNamed('micro_estimate')[0].input.nutrients.map((n) => n.key),
    gaps,
  );

  const info = foodMicros.info(food.id);
  assert.equal(info.twinCode, 'nevo:9001');
  assert.equal(info.status, 'unconfirmed');
  assert.equal(info.job, null);
  assert.deepEqual(info.label, { thiamin: 0.1 });
  assert.deepEqual(info.ai, Object.fromEntries(gaps.map((key) => [key, 1])));
  const { values } = foodMicros.resolve([food.id]).get(food.id);
  assert.deepEqual(values.iodine, { amount: twinValues.iodine, origin: 'nevo' });
});

test('search terms are trimmed and capped at six', async () => {
  await uploadNevo();
  await createFood();
  const searched = [];
  const real = reference.searchCandidates;
  reference.searchCandidates = (terms, limit) => {
    searched.push({ terms, limit });
    return real(terms, limit);
  };
  const matcher = matcherWith({
    micro_search_terms: { terms: [' ei ', '', 'egg', 'a', 'b', 'c', 'd', 'e'] },
    micro_twin: { code: null },
    micro_estimate: { values: [] },
  });
  await matcher.runOnce();
  assert.deepEqual(searched, [{ terms: ['ei', 'egg', 'a', 'b', 'c', 'd'], limit: 40 }]);
});

test('rejects a twin code outside the candidates', async () => {
  await uploadNevo();
  const food = await createFood();
  // 9003 is a NEVO food, but "ei" doesn't find it.
  const matcher = matcherWith({ micro_search_terms: { terms: ['ei'] }, micro_twin: { code: 9003 } });

  assert.equal(await matcher.runOnce(), 1);
  assert.deepEqual(callsNamed('micro_twin')[0].input.candidates.map((c) => c.code), [9001]);
  assert.equal(callsNamed('micro_estimate').length, 0);
  assert.deepEqual({ ...row(food.id) }, { micro_twin_code: null, micro_status: 'pending', micro_job: 'match', micro_attempts: 1 });
  assert.ok(console.error.mock.calls.some((c) => String(c.arguments[0]).includes(`ingredient ${food.id}`)));
});

test('no twin leads to estimates for all gaps and status unconfirmed', async () => {
  await uploadNevo();
  const food = await createFood();
  const matcher = matcherWith({
    micro_search_terms: { terms: ['ei'] },
    micro_twin: { code: null },
    micro_estimate: (request) => ({ values: askedKeys(request).slice(0, 2).map((key) => ({ key, amount: 0.5 })) }),
  });

  await matcher.runOnce();
  assert.deepEqual(askedKeys(callsNamed('micro_estimate')[0]), [...MICRO_KEYS]);
  const info = foodMicros.info(food.id);
  assert.equal(info.twinCode, null);
  assert.equal(info.status, 'unconfirmed');
  assert.equal(info.job, null);
  assert.deepEqual(info.ai, { vitaminA: 0.5, thiamin: 0.5 }, 'nutrients the model skipped stay unknown');
});

test('no candidates skips the twin call and counts as no twin', async () => {
  await uploadNevo();
  const food = await createFood({ name: 'Zuurkool' });
  const matcher = matcherWith({ micro_search_terms: { terms: ['zuurkool', 'sauerkraut'] }, micro_estimate: { values: [] } });

  await matcher.runOnce();
  assert.deepEqual(
    calls.map((call) => call.name),
    ['micro_search_terms', 'micro_estimate'],
  );
  assert.deepEqual({ ...row(food.id) }, { micro_twin_code: null, micro_status: 'unconfirmed', micro_job: null, micro_attempts: 0 });
});

test('drops estimates outside the nutrient\'s range', async () => {
  await uploadNevo();
  const food = await createFood();
  const matcher = matcherWith({
    micro_search_terms: { terms: ['ei'] },
    micro_twin: { code: 9001 },
    micro_estimate: {
      values: [
        { key: 'thiamin', amount: 0.0712345 },
        { key: 'thiamin', amount: 0.2 },
        { key: 'vitaminK', amount: -1 },
        { key: 'vitaminC', amount: 5001 },
        { key: 'copper', amount: Number.NaN },
        { key: 'zinc', amount: '1' },
        { key: 'iodine', amount: 10 },
        { key: 'bogus', amount: 1 },
      ],
    },
  });

  await matcher.runOnce();
  const info = foodMicros.info(food.id);
  assert.deepEqual(info.ai, { thiamin: 0.0712 }, 'only the first in-range estimate of a gap is kept, rounded');
  assert.equal(info.status, 'unconfirmed');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], new RegExp(`ingredient ${food.id}: dropped 7 `));
});

test('parseEstimates keeps the range bounds and rejects a malformed answer', () => {
  assert.deepEqual(parseEstimates({ values: [{ key: 'iron', amount: 0 }, { key: 'iron', amount: 400 }] }, ['iron']), {
    values: { iron: 0 },
    dropped: 1,
  });
  assert.deepEqual(parseEstimates({ values: [{ key: 'iron', amount: 400 }] }, ['iron']).values, { iron: 400 });
  assert.throws(() => parseEstimates({ values: null }, ['iron']), OpenAiError);
});

test('fill job keeps a confirmed status', async () => {
  await uploadNevo();
  const egg = (await client.post('/api/reference/nevo/9001/adopt')).body;
  server.db
    .prepare("INSERT INTO ingredient_micros (ingredient_id, nutrient, amount, origin) VALUES (?, 'thiamin', 0.06, 'ai')")
    .run(egg.id);
  const matcher = matcherWith({ micro_estimate: estimateAll });

  assert.equal(await matcher.runOnce(), 1);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['micro_estimate'],
  );
  const twinValues = reference.getMicros(9001);
  const gaps = MICRO_KEYS.filter((key) => key !== 'thiamin' && !(key in twinValues));
  assert.deepEqual(askedKeys(calls[0]), gaps, 'existing ai values are not re-estimated');
  const info = foodMicros.info(egg.id);
  assert.equal(info.twinCode, 'nevo:9001');
  assert.equal(info.status, 'confirmed');
  assert.equal(info.job, null);
  assert.deepEqual(info.ai, { thiamin: 0.06, ...Object.fromEntries(gaps.map((key) => [key, 1])) });
});

test('no gaps means no estimate call', async () => {
  await uploadNevo();
  const food = await createFood({ micros: Object.fromEntries(MICRO_KEYS.map((key) => [key, 1])) });
  const matcher = matcherWith({ micro_search_terms: { terms: ['ei'] }, micro_twin: { code: 9001 } });

  await matcher.runOnce();
  assert.equal(callsNamed('micro_estimate').length, 0);
  assert.deepEqual({ ...row(food.id) }, { micro_twin_code: 'nevo:9001', micro_status: 'unconfirmed', micro_job: null, micro_attempts: 0 });
});

test('gives up after 3 failures and marks the food none', async () => {
  await uploadNevo();
  const food = await createFood();
  const matcher = matcherWith({ micro_search_terms: new OpenAiError('model refused: no') });

  for (const expected of [1, 2]) {
    assert.equal(await matcher.runOnce(), 1, 'a failing food is tried once per run');
    assert.deepEqual({ ...row(food.id) }, { micro_twin_code: null, micro_status: 'pending', micro_job: 'match', micro_attempts: expected });
  }
  assert.equal(await matcher.runOnce(), 1);
  assert.deepEqual({ ...row(food.id) }, { micro_twin_code: null, micro_status: 'none', micro_job: null, micro_attempts: 3 });
  assert.equal(await matcher.runOnce(), 0);
  assert.equal(calls.length, 3);
});

test('a failing food does not stop the rest of the queue', async () => {
  await uploadNevo();
  const bad = await createFood({ name: 'Mystery' });
  const good = await createFood();
  const matcher = matcherWith({
    micro_search_terms: (request) =>
      JSON.parse(request.input).food.name === 'Mystery' ? new OpenAiError('response text is not valid JSON') : { terms: ['ei'] },
    micro_twin: { code: 9001 },
    micro_estimate: { values: [] },
  });

  assert.equal(await matcher.runOnce(), 2);
  assert.equal(row(bad.id).micro_attempts, 1);
  assert.equal(row(good.id).micro_job, null);
});

test('an unavailable OpenAI stops the run without counting attempts', async () => {
  await uploadNevo();
  const first = await createFood({ name: 'First' });
  const second = await createFood({ name: 'Second' });
  const unavailable = new OpenAiError('returned 503: overloaded', { kind: OpenAiErrorKind.UNAVAILABLE });
  const down = matcherWith({ micro_search_terms: unavailable });

  assert.equal(await down.runOnce(), 1, 'stops at the first food');
  assert.deepEqual(calls.map((call) => call.input.food.name), ['First'], 'the second food is not tried while OpenAI is down');
  // More runs than MAX_ATTEMPTS: an outage must never give a food up.
  for (let run = 0; run < 3; run += 1) await down.runOnce();
  assert.deepEqual({ ...row(first.id) }, { micro_twin_code: null, micro_status: 'pending', micro_job: 'match', micro_attempts: 0 });
  assert.equal(row(second.id).micro_attempts, 0);
  assert.equal(warn.mock.callCount(), 0);

  const up = matcherWith({ micro_search_terms: { terms: ['ei'] }, micro_twin: { code: 9001 }, micro_estimate: estimateAll });
  assert.equal(await up.runOnce(), 2, 'the next run picks the queue up again');
  assert.equal(row(first.id).micro_job, null);
  assert.equal(row(second.id).micro_job, null);
});

test('errors other than OpenAiError propagate and leave the attempts alone', async () => {
  await uploadNevo();
  const food = await createFood();
  const matcher = matcherWith({ micro_search_terms: new TypeError('bug') });
  await assert.rejects(matcher.runOnce(), TypeError);
  assert.equal(row(food.id).micro_attempts, 0);
});

test('a twin the user picks while the AI is busy wins', async () => {
  await uploadNevo();
  const food = await createFood();
  const matcher = matcherWith({
    micro_search_terms: { terms: ['ei'] },
    micro_twin: () => {
      foodMicros.setTwin(food.id, 9002);
      return { code: 9001 };
    },
    micro_estimate: { values: [] },
  });

  assert.equal(await matcher.runOnce(), 1, 'the food is not handled twice in one run');
  const info = foodMicros.info(food.id);
  assert.equal(info.twinCode, 'nevo:9002');
  assert.equal(info.status, 'confirmed');
  assert.equal(info.job, 'fill', "the user's change queued a fill job for the next run");
  assert.equal(row(food.id).micro_attempts, 0);
  assert.match(warn.mock.calls.at(-1).arguments[0], new RegExp(`ingredient ${food.id} skipped`));
});

test('a confirm during a fill run keeps confirmed', async () => {
  await uploadNevo();
  const food = await createFood();
  server.db
    .prepare("UPDATE ingredients SET micro_twin_code = 'nevo:9001', micro_status = 'unconfirmed', micro_job = 'fill' WHERE id = ?")
    .run(food.id);
  const matcher = matcherWith({
    micro_estimate: (request) => {
      foodMicros.confirm(food.id);
      return { values: [{ key: askedKeys(request)[0], amount: 1 }] };
    },
  });

  assert.equal(await matcher.runOnce(), 1);
  const info = foodMicros.info(food.id);
  assert.equal(info.status, 'confirmed');
  assert.equal(info.job, null);
  assert.equal(Object.keys(info.ai).length, 1, 'the estimates are still stored');
});

test('a food archived or deleted while the AI is busy is skipped without failing', async () => {
  await uploadNevo();
  const archived = await createFood({ name: 'Archived' });
  const deleted = await createFood({ name: 'Deleted' });
  const matcher = matcherWith({
    micro_search_terms: async (request) => {
      const { name } = JSON.parse(request.input).food;
      if (name === 'Archived') await client.del(`/api/ingredients/${archived.id}`);
      else server.db.prepare('DELETE FROM ingredients WHERE id = ?').run(deleted.id);
      return new OpenAiError('timeout');
    },
  });

  assert.equal(await matcher.runOnce(), 2);
  assert.deepEqual({ ...row(archived.id) }, { micro_twin_code: null, micro_status: 'pending', micro_job: 'match', micro_attempts: 0 });
  assert.equal(row(deleted.id), undefined);
  assert.equal(warn.mock.callCount(), 2);
});

test('sends only name, brand, macros and candidates', async () => {
  await uploadNevo();
  await createFood({ fiber: 2, portions: [{ label: 'egg', grams: 60 }] });
  const matcher = matcherWith({
    micro_search_terms: { terms: ['ei'] },
    micro_twin: { code: null },
    micro_estimate: { values: [] },
  });

  await matcher.runOnce();
  const food = { name: 'Scharreleieren', brand: 'Boer Jan', per100g: { kcal: 140, protein: 12, carbs: 1, fat: 10 } };
  const [search, twin, estimate] = calls;
  assert.deepEqual(search.input, { food });
  assert.deepEqual(Object.keys(twin.input), ['food', 'candidates']);
  assert.deepEqual(twin.input.food, food);
  assert.deepEqual(Object.keys(twin.input.candidates[0]).sort(), [
    'carbs',
    'code',
    'fat',
    'group',
    'kcal',
    'name',
    'nameEn',
    'protein',
  ]);
  assert.deepEqual(Object.keys(estimate.input), ['food', 'nutrients']);
  assert.deepEqual(estimate.input.food, food);
  assert.deepEqual(estimate.input.nutrients.find((n) => n.key === 'salt'), { key: 'salt', label: 'Salt', unit: 'g' });
});

test('schemas are strict', async () => {
  await uploadNevo();
  await createFood();
  const matcher = matcherWith({
    micro_search_terms: { terms: ['ei'] },
    micro_twin: { code: null },
    micro_estimate: { values: [] },
  });
  await matcher.runOnce();
  const strict = (schema) => {
    if (schema.type !== 'object') return schema.items ? strict(schema.items) : undefined;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    Object.values(schema.properties).forEach(strict);
  };
  for (const call of calls) strict(call.schema);
  assert.deepEqual(calls[1].schema.properties.code, { type: ['integer', 'null'] });
});

test('start runs at once, never overlaps runs, and survives a crashed run', async () => {
  await uploadNevo();
  await createFood();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let runs = 0;
  const matcher = matcherWith(
    {
      micro_search_terms: async () => {
        runs += 1;
        if (runs === 1) await gate;
        return new TypeError('bug');
      },
    },
    { intervalMs: 5 },
  );

  matcher.start();
  assert.equal(runs, 1, 'the first run starts immediately');
  await sleep(40);
  assert.equal(runs, 1, 'ticks are skipped while a run is busy');
  release();
  await sleep(40);
  matcher.stop();
  assert.ok(runs > 1, 'the timer keeps going after a crashed run');
  assert.ok(console.error.mock.calls.some((c) => c.arguments[0] === 'Micronutrient matcher run failed'));
  const after = runs;
  await sleep(30);
  assert.equal(runs, after, 'stop clears the timer');
});
