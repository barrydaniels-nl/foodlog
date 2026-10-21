import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api } from './helpers.js';
import { buildAnalysisInput, parseAnalysis } from '../server/analysis.js';
import { OpenAiError } from '../server/openai.js';

const ANALYSIS = {
  summary: 'You are at 520 of 2000 kcal and 30 of 120 g protein.',
  protein: ['Swap the oats for magere kwark (≈ +20 g protein).'],
  calories: [],
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
  const input = buildAnalysisInput({ day: dayWithBreakfast(), foods, isToday: true, now: new Date(2026, 9, 21, 22, 30) });
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
  const input = buildAnalysisInput({ day: dayWithBreakfast(), foods: [], isToday: false, now: new Date(2026, 9, 21, 22, 30) });
  assert.equal(input.time, null);
  assert.equal(input.mealsAhead, null);
});

test('parseAnalysis caps and trims', () => {
  const protein = ['  one  ', '', 'two', 'three ', ' four', 'five', 'six'];
  assert.deepEqual(parseAnalysis({ summary: '  Fine day. ', protein, calories: [] }), {
    summary: 'Fine day.',
    protein: ['one', 'two', 'three', 'four'],
    calories: [],
  });
});

test('parseAnalysis rejects a missing summary or tip lists', () => {
  assert.throws(() => parseAnalysis({ protein: [], calories: [] }), OpenAiError);
  assert.throws(() => parseAnalysis({ summary: '  ', protein: [], calories: [] }), OpenAiError);
  assert.throws(() => parseAnalysis({ summary: 'Ok', protein: 'eat eggs', calories: [] }), OpenAiError);
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
  const { oats } = await start({ openAi: fakeOpenAi(() => ({ summary: '', protein: [], calories: [] })) });
  await planOats('2026-10-21', oats);
  assert.equal((await client.post('/api/days/2026-10-21/analysis')).status, 502);
});
