import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';
import { ANALYSIS_INSTRUCTIONS, ANALYSIS_SCHEMA, buildAnalysisInput, parseAnalysis } from '../server/analysis.js';
import { OpenAiError } from '../server/openai.js';

const ANALYSIS = {
  summary: 'You are at 520 of 2000 kcal and 30 of 120 g protein.',
  protein: ['Swap the oats for magere kwark (≈ +20 g protein).'],
  calories: [],
  micronutrients: [],
};

let server;
let client;
let calls;

/** Fake OpenAI client: records requests and answers with `answer()`. */
function fakeOpenAi(answer = () => ANALYSIS) {
  calls = [];
  return {
    generateJson: async (request) => {
      calls.push(request);
      return answer(request);
    },
  };
}

async function start(options = {}) {
  server = await startTestServer({ today: '2026-10-21', ...options });
  client = api(server.url);
  const oats = (await client.post('/api/ingredients', { name: 'Oats', kcal: 380, protein: 13, carbs: 60, fat: 7 })).body;
  return { oats };
}

async function planOats(date, oats) {
  await client.post(`/api/days/${date}/entries`, { slot: 'breakfast', ingredientId: oats.id, grams: 60 });
}

beforeEach((t) => t.mock.method(console, 'error', () => {}));
afterEach(() => server?.close());

/** A micro day as returned by micros.getDay, with a null-heavy vitamin D row and a full vitamin C row. */
function microDay(supplements = []) {
  return {
    date: '2026-10-21',
    profile: null,
    supplements,
    nutrients: [
      {
        key: 'vitaminD',
        label: 'Vitamin D',
        unit: 'µg',
        food: 1.2,
        supplements: 0,
        total: 1.2,
        recommended: null,
        upperLimit: null,
        ulBasis: 'total',
        limitAmount: 1.2,
        percent: null,
        overLimit: false,
        estimatedShare: 0.5,
        unknownGrams: 40,
        unknownShare: 0.25,
        sources: [],
      },
      {
        key: 'vitaminC',
        label: 'Vitamin C',
        unit: 'mg',
        food: 30,
        supplements: 80,
        total: 110,
        recommended: 75,
        upperLimit: 1000,
        ulBasis: 'supplement',
        limitAmount: 80,
        percent: 147,
        overLimit: false,
        estimatedShare: 0,
        unknownGrams: 0,
        unknownShare: 0,
        sources: [],
      },
    ],
    coverage: { missingFoods: 0, missingGrams: 0 },
  };
}

const NOW = new Date(2026, 9, 21, 22, 30);
const SET = [{ supplementId: 1, name: 'Fish oil', unitLabel: 'capsule', units: 2 }];

/** A day as returned by days.getDay, with one breakfast entry. */
function dayWithBreakfast() {
  const empty = { entries: [], totals: {} };
  return {
    date: '2026-10-21',
    targets: { kcal: 2000, protein: 120 },
    totals: { kcal: 228, protein: 7.8, carbs: 36, fat: 4.2, fiber: 0 },
    slots: {
      breakfast: {
        entries: [
          {
            name: 'Oats',
            brand: null,
            grams: 60,
            per100: { kcal: 380, protein: 13, carbs: 60, fat: 7, fiber: 0 },
            nutrients: { kcal: 228, protein: 7.8, carbs: 36, fat: 4.2, fiber: 0 },
          },
        ],
        totals: {},
      },
      lunch: empty,
      dinner: empty,
      snacks: empty,
    },
  };
}

test('buildAnalysisInput on today includes time and mealsAhead', () => {
  const foods = [{ name: 'Oats', brand: null, kcal: 380, protein: 13, carbs: 60, fat: 7 }];
  const input = buildAnalysisInput({ day: dayWithBreakfast(), foods, isToday: true, now: NOW, microDay: microDay(), supplementSet: [] });
  assert.equal(input.time, '22:30');
  assert.deepEqual(input.mealsAhead, ['snacks']);
  assert.deepEqual(input.meals.breakfast, [
    { name: 'Oats', brand: null, grams: 60, kcal: 228, protein: 7.8, per100: { kcal: 380, protein: 13, carbs: 60, fat: 7 } },
  ]);
  assert.deepEqual(input.meals.lunch, []);
  assert.deepEqual(input.targets, { kcal: 2000, protein: 120 });
  assert.equal(input.totals.kcal, 228);
  assert.equal(input.foods, foods);
});

test('buildAnalysisInput on a future day has no time or mealsAhead', () => {
  const input = buildAnalysisInput({ day: dayWithBreakfast(), foods: [], isToday: false, now: NOW, microDay: microDay(), supplementSet: [] });
  assert.equal(input.time, null);
  assert.equal(input.mealsAhead, null);
});

test('analysis input includes micronutrients and logged supplements', () => {
  const entries = [{ id: 7, date: '2026-10-21', supplementId: 2, name: 'Vitamin D3', brand: 'Acme', unitLabel: 'tablet', units: 1, position: 0 }];
  const input = buildAnalysisInput({
    day: dayWithBreakfast(),
    foods: [],
    isToday: true,
    now: NOW,
    microDay: microDay(entries),
    supplementSet: SET,
  });
  assert.deepEqual(input.micronutrients, [
    {
      key: 'vitaminD',
      unit: 'µg',
      food: 1.2,
      supplements: 0,
      ulBasis: 'total',
      limitAmount: 1.2,
      overLimit: false,
      estimatedShare: 0.5,
      unknownGrams: 40,
    },
    {
      key: 'vitaminC',
      unit: 'mg',
      food: 30,
      supplements: 80,
      recommended: 75,
      upperLimit: 1000,
      ulBasis: 'supplement',
      limitAmount: 80,
      percent: 147,
      overLimit: false,
      estimatedShare: 0,
    },
  ]);
  assert.equal('unknownGrams' in input.micronutrients[1], false, 'an unknownGrams of 0 is left out');
  assert.deepEqual(input.supplements, { logged: true, items: [{ name: 'Vitamin D3', units: 1, unitLabel: 'tablet' }] });
});

test('analysis input uses the daily set when no supplements are logged', () => {
  const input = buildAnalysisInput({
    day: dayWithBreakfast(),
    foods: [],
    isToday: false,
    now: NOW,
    microDay: microDay(),
    supplementSet: SET,
  });
  assert.deepEqual(input.supplements, { logged: false, items: [{ name: 'Fish oil', units: 2, unitLabel: 'capsule' }] });
  const empty = buildAnalysisInput({ day: dayWithBreakfast(), foods: [], isToday: false, now: NOW, microDay: microDay(), supplementSet: [] });
  assert.deepEqual(empty.supplements, { logged: false, items: [] });
});

test('the analysis prompt explains the upper-limit basis and the unknown grams', () => {
  assert.match(ANALYSIS_INSTRUCTIONS, /overLimit is authoritative/);
  assert.match(ANALYSIS_INSTRUCTIONS, /compared with limitAmount, never with the total/);
  assert.match(ANALYSIS_INSTRUCTIONS, /When unknownGrams is large .* say the amount is uncertain instead of advising a supplement/);
});

test('the analysis schema is strict and requires every property', () => {
  assert.equal(ANALYSIS_SCHEMA.additionalProperties, false);
  assert.deepEqual(ANALYSIS_SCHEMA.required, Object.keys(ANALYSIS_SCHEMA.properties));
  assert.deepEqual(ANALYSIS_SCHEMA.required, ['summary', 'protein', 'calories', 'micronutrients']);
});

test('parseAnalysis caps and trims', () => {
  const protein = ['  one  ', '', 'two', 'three ', ' four', 'five', 'six'];
  assert.deepEqual(parseAnalysis({ summary: '  Fine day. ', protein, calories: [], micronutrients: [] }), {
    summary: 'Fine day.',
    protein: ['one', 'two', 'three', 'four'],
    calories: [],
    micronutrients: [],
  });
});

test('parseAnalysis caps micronutrient tips at 4', () => {
  const micronutrients = [' a ', '', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(parseAnalysis({ summary: 'Ok', protein: [], calories: [], micronutrients }).micronutrients, ['a', 'b', 'c', 'd']);
});

test('parseAnalysis rejects a missing summary or tip lists', () => {
  assert.throws(() => parseAnalysis({ protein: [], calories: [], micronutrients: [] }), OpenAiError);
  assert.throws(() => parseAnalysis({ summary: '  ', protein: [], calories: [], micronutrients: [] }), OpenAiError);
  assert.throws(() => parseAnalysis({ summary: 'Ok', protein: 'eat eggs', calories: [], micronutrients: [] }), OpenAiError);
  assert.throws(() => parseAnalysis({ summary: 'Ok', protein: [], calories: [] }), OpenAiError);
  assert.throws(() => parseAnalysis(null), OpenAiError);
});

test('status reports disabled without a client', async () => {
  await start();
  assert.deepEqual((await client.get('/api/analysis/status')).body, { enabled: false });
});

test('status reports enabled with a client', async () => {
  await start({ openAi: fakeOpenAi() });
  assert.deepEqual((await client.get('/api/analysis/status')).body, { enabled: true });
});

test('analysis answers 503 when disabled', async () => {
  const { oats } = await start();
  await planOats('2026-10-21', oats);
  const res = await client.post('/api/days/2026-10-21/analysis');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'Day analysis is off. Set OPENAI_API_KEY to turn it on.');
});

test('analysis rejects a past day', async () => {
  const { oats } = await start({ openAi: fakeOpenAi() });
  await planOats('2026-10-20', oats);
  const res = await client.post('/api/days/2026-10-20/analysis');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Only today and future days can be analysed');
  assert.equal(calls.length, 0);
});

test('analysis rejects an empty day', async () => {
  await start({ openAi: fakeOpenAi() });
  const res = await client.post('/api/days/2026-10-21/analysis');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Plan some food first');
  assert.equal(calls.length, 0);
});

test('analysis rejects an invalid date', async () => {
  await start({ openAi: fakeOpenAi() });
  assert.equal((await client.post('/api/days/not-a-date/analysis')).status, 400);
});

test('analysis returns the parsed tips for today', async () => {
  const { oats } = await start({ openAi: fakeOpenAi(), now: () => new Date(2026, 9, 21, 14, 0) });
  await client.put('/api/settings', { kcalTarget: 2200, proteinTarget: 160 });
  await planOats('2026-10-21', oats);
  const res = await client.post('/api/days/2026-10-21/analysis');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ANALYSIS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'day_analysis');
  assert.equal(calls[0].schema.additionalProperties, false);
  const input = JSON.parse(calls[0].input);
  assert.deepEqual(input.targets, { kcal: 2200, protein: 160 });
  assert.deepEqual(input.mealsAhead, ['lunch', 'dinner', 'snacks']);
  assert.equal(input.time, '14:00');
  assert.deepEqual(input.foods, [{ name: 'Oats', brand: null, kcal: 380, protein: 13, carbs: 60, fat: 7 }]);
  assert.equal(input.micronutrients.length, 23);
  assert.deepEqual(input.supplements, { logged: false, items: [] });
});

test('analysis sends the logged supplements, or the daily set when none are logged', async () => {
  const { oats } = await start({ openAi: fakeOpenAi() });
  const fish = (await client.post('/api/supplements', { name: 'Fish oil', unitLabel: 'capsule', nutrients: { epaDha: 500 } })).body;
  await client.put('/api/supplement-set', { items: [{ supplementId: fish.id, units: 2 }] });
  await planOats('2026-10-21', oats);

  await client.post('/api/days/2026-10-21/analysis');
  assert.deepEqual(JSON.parse(calls[0].input).supplements, {
    logged: false,
    items: [{ name: 'Fish oil', units: 2, unitLabel: 'capsule' }],
  });

  await client.post('/api/days/2026-10-21/supplements', { supplementId: fish.id, units: 1 });
  await client.post('/api/days/2026-10-21/analysis');
  assert.deepEqual(JSON.parse(calls[1].input).supplements, {
    logged: true,
    items: [{ name: 'Fish oil', units: 1, unitLabel: 'capsule' }],
  });
});

test('analysis works for a future day', async () => {
  const { oats } = await start({ openAi: fakeOpenAi() });
  await planOats('2026-10-25', oats);
  const res = await client.post('/api/days/2026-10-25/analysis');
  assert.equal(res.status, 200);
  const input = JSON.parse(calls[0].input);
  assert.equal(input.date, '2026-10-25');
  assert.equal(input.time, null);
  assert.equal(input.mealsAhead, null);
});

test('analysis maps OpenAiError to 502 with the failure copy', async () => {
  const { oats } = await start({
    openAi: fakeOpenAi(() => {
      throw new OpenAiError('returned 500');
    }),
  });
  await planOats('2026-10-21', oats);
  const res = await client.post('/api/days/2026-10-21/analysis');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "Couldn't analyse your day right now. Try again in a moment.");
});

test('analysis maps a malformed model answer to 502', async () => {
  const { oats } = await start({ openAi: fakeOpenAi(() => ({ summary: '', protein: [], calories: [], micronutrients: [] })) });
  await planOats('2026-10-21', oats);
  assert.equal((await client.post('/api/days/2026-10-21/analysis')).status, 502);
});
