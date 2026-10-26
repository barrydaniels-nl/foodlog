import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, api } from './helpers.js';
import { MICRO_KEYS } from '../public/js/shared/micronutrients.js';
import { createMicrosService } from '../server/micros.js';
import { createSettingsRepo } from '../server/settings.js';
import { createReferenceRepo } from '../server/nevo.js';
import { createFoodMicrosRepo } from '../server/food-micros.js';
import { createSupplementsRepo } from '../server/supplements.js';

const SAMPLE = readFileSync(new URL('./fixtures/nevo-sample.csv', import.meta.url), 'utf8');
const TODAY = '2026-10-21';
const YESTERDAY = '2026-10-20';

let server;
let client;

beforeEach(async () => {
  server = await startTestServer({ today: TODAY });
  client = api(server.url);
});
afterEach(() => server.close());

const setProfile = async (profile = { sex: 'male', birthYear: 1980 }) => {
  const res = await client.put('/api/settings', profile);
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

/** A manual food with label micronutrients per 100 g; without `micros` it has no data at all. */
async function createFood(name, micros) {
  const res = await client.post('/api/ingredients', { name, kcal: 100, protein: 1, carbs: 10, fat: 1, micros });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function log(date, ingredientId, grams) {
  const res = await client.post(`/api/days/${date}/entries`, { slot: 'breakfast', ingredientId, grams });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

async function createSupplement(name, nutrients) {
  const res = await client.post('/api/supplements', { name, unitLabel: 'tablet', nutrients });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** @returns {Promise<object[]>} the day's supplement entries */
async function take(date, supplementId, units = 1) {
  const res = await client.post(`/api/days/${date}/supplements`, { supplementId, units });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function getDay(date) {
  const res = await client.get(`/api/micros/days/${date}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function getMonth(month) {
  const res = await client.get(`/api/micros/months/${month}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const rowOf = (summary, key) => summary.nutrients.find((row) => row.key === key);

test('day sums food and supplements per nutrient', async () => {
  await setProfile();
  const orange = await createFood('Orange', { vitaminC: 50, iron: 2 });
  await log(YESTERDAY, orange.id, 120);
  await log(YESTERDAY, orange.id, 80);
  const tablet = await createSupplement('Vitamin C', { vitaminC: 80 });
  const supplementEntries = await take(YESTERDAY, tablet.id, 2);

  const day = await getDay(YESTERDAY);
  assert.equal(day.date, YESTERDAY);
  assert.deepEqual(day.profile, { sex: 'male', age: 46 });
  assert.deepEqual(day.supplements, supplementEntries);
  assert.deepEqual(
    day.nutrients.map((row) => row.key),
    MICRO_KEYS,
  );

  assert.deepEqual(rowOf(day, 'vitaminC'), {
    key: 'vitaminC',
    label: 'Vitamin C',
    unit: 'mg',
    group: 'vitamins',
    food: 100,
    supplements: 160,
    total: 260,
    recommended: 75,
    indicative: false,
    upperLimit: null,
    limitKind: null,
    ulBasis: 'none',
    limitAmount: null,
    percent: 347,
    status: 'good',
    overLimit: false,
    estimatedShare: 0,
    unknownGrams: 0,
    unknownShare: 0,
    sources: [
      { kind: 'supplement', id: tablet.id, name: 'Vitamin C', amount: 160, share: 0.62 },
      { kind: 'food', id: orange.id, name: 'Orange', amount: 100, share: 0.38 },
    ],
  });

  const iron = rowOf(day, 'iron');
  assert.equal(iron.total, 4);
  assert.equal(iron.percent, 36);
  assert.equal(iron.status, 'low');
  assert.equal(iron.limitAmount, 4, 'basis total compares food + supplements');
  assert.deepEqual([iron.upperLimit, iron.limitKind, iron.overLimit], [40, 'safe', false]);

  const nothing = rowOf(day, 'vitaminK');
  assert.deepEqual([nothing.total, nothing.percent, nothing.status, nothing.sources], [0, 0, 'low', []]);
  assert.equal(rowOf(day, 'thiamin').recommended, 0.837, 'energy-based amount from the 2000 kcal target');
});

test('folic acid counts as DFE x1.7 but the upper limit uses the raw amount', async () => {
  await setProfile();
  const bread = await createFood('Bread', { folate: 100 });
  await log(YESTERDAY, bread.id, 100);
  const folicAcid = await createSupplement('Folic acid', { folate: 700 });
  const [entry] = await take(YESTERDAY, folicAcid.id, 1);

  let folate = rowOf(await getDay(YESTERDAY), 'folate');
  assert.equal(folate.food, 100);
  assert.equal(folate.supplements, 1190, '700 µg folic acid is 1190 µg DFE');
  assert.equal(folate.total, 1290);
  assert.equal(folate.ulBasis, 'supplement');
  assert.equal(folate.limitAmount, 700);
  assert.equal(folate.upperLimit, 1000);
  assert.equal(folate.overLimit, false, 'DFE and food are above 1000, the folic acid itself is not');

  await client.patch(`/api/supplement-entries/${entry.id}`, { units: 2 });
  folate = rowOf(await getDay(YESTERDAY), 'folate');
  assert.equal(folate.limitAmount, 1400);
  assert.equal(folate.supplements, 2380);
  assert.equal(folate.overLimit, true);
});

test('upper limit basis supplement ignores food', async () => {
  await setProfile();
  const nuts = await createFood('Nuts', { magnesium: 100 });

  const tablet300 = await createSupplement('Magnesium 300', { magnesium: 300 });
  await log('2026-10-19', nuts.id, 400);
  await take('2026-10-19', tablet300.id);
  const over = rowOf(await getDay('2026-10-19'), 'magnesium');
  assert.deepEqual([over.total, over.limitAmount, over.upperLimit, over.overLimit], [700, 300, 250, true]);

  const tablet200 = await createSupplement('Magnesium 200', { magnesium: 200 });
  await log(YESTERDAY, nuts.id, 600);
  await take(YESTERDAY, tablet200.id);
  const under = rowOf(await getDay(YESTERDAY), 'magnesium');
  assert.deepEqual([under.total, under.limitAmount, under.overLimit], [800, 200, false]);
});

test('vitamin A upper limit uses retinol, not RAE', async () => {
  await setProfile();
  await client.post('/api/reference/nevo', { csv: SAMPLE });
  // The NEVO egg has 180 µg retinol per 100 g; its RAE comes from the label value set here.
  const egg = (await client.post('/api/reference/nevo/9001/adopt')).body;
  await client.put(`/api/ingredients/${egg.id}/micros/values`, { values: { vitaminA: 1000 } });
  const carrot = await createFood('Carrot', { vitaminA: 800 });

  await log('2026-10-19', egg.id, 500);
  await log('2026-10-19', carrot.id, 100);
  const foodOnly = rowOf(await getDay('2026-10-19'), 'vitaminA');
  assert.equal(foodOnly.total, 5800);
  assert.equal(foodOnly.ulBasis, 'retinol');
  assert.equal(foodOnly.limitAmount, 900, 'only the egg retinol counts; carotenoids do not');
  assert.equal(foodOnly.overLimit, false, 'RAE is far above 3000, retinol is not');

  const retinolTablet = await createSupplement('Vitamin A', { vitaminA: 2500 });
  await log(YESTERDAY, egg.id, 500);
  await take(YESTERDAY, retinolTablet.id);
  const withSupplement = rowOf(await getDay(YESTERDAY), 'vitaminA');
  assert.equal(withSupplement.limitAmount, 3400);
  assert.equal(withSupplement.overLimit, true);
});

test('estimated share counts ai values and unconfirmed twins', async () => {
  await setProfile();
  await client.post('/api/reference/nevo', { csv: SAMPLE });
  // The NEVO pak choi has 45 mg vitamin C per 100 g.
  const measured = await createFood('Measured', { vitaminC: 10 });
  const unconfirmed = await createFood('Unconfirmed twin');
  server.db
    .prepare("UPDATE ingredients SET micro_twin_code = 'nevo:9002', micro_status = 'unconfirmed' WHERE id = ?")
    .run(unconfirmed.id);
  const confirmed = await createFood('Confirmed twin');
  assert.equal((await client.put(`/api/ingredients/${confirmed.id}/micros/twin`, { code: 9002 })).status, 200);
  const estimated = await createFood('AI estimate');
  server.db
    .prepare("INSERT INTO ingredient_micros (ingredient_id, nutrient, amount, origin) VALUES (?, 'vitaminC', 20, 'ai')")
    .run(estimated.id);
  const tablet = await createSupplement('Vitamin C', { vitaminC: 30 });

  for (const food of [measured, unconfirmed, confirmed, estimated]) await log(YESTERDAY, food.id, 100);
  await take(YESTERDAY, tablet.id);

  const day = await getDay(YESTERDAY);
  const vitaminC = rowOf(day, 'vitaminC');
  assert.equal(vitaminC.total, 150);
  assert.equal(vitaminC.estimatedShare, 0.43, '(45 unconfirmed twin + 20 ai) / 150');
  assert.equal(rowOf(await getDay('2026-10-19'), 'vitaminC').estimatedShare, 0, 'no total means nothing estimated');
});

test('day without profile has null recommended and status', async () => {
  const salty = await createFood('Salty', { vitaminC: 50, salt: 4 });
  await log(YESTERDAY, salty.id, 200);

  let day = await getDay(YESTERDAY);
  assert.equal(day.profile, null);
  const vitaminC = rowOf(day, 'vitaminC');
  assert.equal(vitaminC.total, 100);
  assert.deepEqual(
    [vitaminC.recommended, vitaminC.percent, vitaminC.status, vitaminC.upperLimit, vitaminC.limitKind, vitaminC.indicative],
    [null, null, null, null, null, false],
  );
  assert.equal(rowOf(day, 'salt').overLimit, false, 'no profile means no limits either');

  await setProfile({ sex: 'female', birthYear: 1990 });
  day = await getDay(YESTERDAY);
  assert.deepEqual(day.profile, { sex: 'female', age: 36 });
  const salt = rowOf(day, 'salt');
  assert.deepEqual(
    [salt.total, salt.recommended, salt.percent, salt.status, salt.upperLimit, salt.limitKind, salt.overLimit],
    [8, null, null, null, 6, 'guideline', true],
    'salt has a guideline maximum but no recommended amount',
  );
});

test('coverage counts foods without any micronutrient data', async () => {
  const unknownA = await createFood('Mystery stew');
  const unknownB = await createFood('Odd snack');
  const known = await createFood('Known', { vitaminC: 5 });
  await log(YESTERDAY, unknownA.id, 100);
  await log(YESTERDAY, unknownA.id, 100);
  await log(YESTERDAY, unknownB.id, 80);
  await log(YESTERDAY, known.id, 300);

  assert.deepEqual((await getDay(YESTERDAY)).coverage, { missingFoods: 2, missingGrams: 280 });
  assert.deepEqual((await getDay('2026-10-19')).coverage, { missingFoods: 0, missingGrams: 0 });
});

test('unknownGrams counts the grams of food without a value per nutrient', async () => {
  const orange = await createFood('Orange', { vitaminC: 50, iron: 2 });
  const juice = await createFood('Juice', { vitaminC: 40 });
  const mystery = await createFood('Mystery');
  await log(YESTERDAY, orange.id, 200);
  await log(YESTERDAY, juice.id, 50);
  await log(YESTERDAY, mystery.id, 100);
  const tablet = await createSupplement('Iron', { iron: 10 });
  await take(YESTERDAY, tablet.id);

  const day = await getDay(YESTERDAY);
  const unknown = (key) => [rowOf(day, key).unknownGrams, rowOf(day, key).unknownShare];
  assert.deepEqual(unknown('vitaminC'), [100, 0.29]);
  assert.deepEqual(unknown('iron'), [150, 0.43], 'a supplement does not make food grams known');
  assert.deepEqual(unknown('vitaminK'), [350, 1]);

  const empty = await getDay('2026-10-19');
  assert.deepEqual([rowOf(empty, 'vitaminC').unknownGrams, rowOf(empty, 'vitaminC').unknownShare], [0, 0], 'no food, no share');
});

test('top sources are sorted, capped at 8 plus others', async () => {
  await setProfile();
  for (let i = 1; i <= 10; i += 1) {
    const food = await createFood(`Food ${i}`, { vitaminC: i * 10 });
    await log(YESTERDAY, food.id, 100);
  }
  const empty = await createFood('No vitamin C', { vitaminC: 0 });
  await log(YESTERDAY, empty.id, 100);
  const tablet = await createSupplement('Tiny C', { vitaminC: 5 });
  await take(YESTERDAY, tablet.id);

  const { sources, total } = rowOf(await getDay(YESTERDAY), 'vitaminC');
  assert.equal(total, 555);
  assert.deepEqual(
    sources.map((source) => [source.kind, source.name, source.amount]),
    [
      ['food', 'Food 10', 100],
      ['food', 'Food 9', 90],
      ['food', 'Food 8', 80],
      ['food', 'Food 7', 70],
      ['food', 'Food 6', 60],
      ['food', 'Food 5', 50],
      ['food', 'Food 4', 40],
      ['food', 'Food 3', 30],
      ['other', 'Others', 35],
    ],
    'Food 2, Food 1 and the tablet are folded into others; the zero source is left out',
  );
  assert.equal(sources[0].share, 0.18);
  assert.deepEqual(sources.at(-1), { kind: 'other', id: null, name: 'Others', amount: 35, share: 0.06 });
});

test('a food source uses the most recent entry name', async () => {
  const food = await createFood('Orange', { vitaminC: 50 });
  await log(YESTERDAY, food.id, 100);
  const renamed = await client.put(`/api/ingredients/${food.id}`, { name: 'Blood orange', kcal: 100, protein: 1, carbs: 10, fat: 1 });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  await log(YESTERDAY, food.id, 100);

  const { sources } = rowOf(await getDay(YESTERDAY), 'vitaminC');
  assert.deepEqual(sources, [{ kind: 'food', id: food.id, name: 'Blood orange', amount: 100, share: 1 }]);
});

test('month averages completed days only and counts days below 66 percent', async () => {
  await setProfile();
  const juice = await createFood('Juice', { vitaminC: 100 });
  const mystery = await createFood('Mystery');
  const magnesium = await createSupplement('Magnesium', { magnesium: 300 });
  const megaC = await createSupplement('Mega C', { vitaminC: 1000 });

  await take('2026-10-18', megaC.id); // supplement-only day: not completed
  await log('2026-10-19', juice.id, 30); // 40% of 75 mg
  await take('2026-10-19', magnesium.id);
  await log(YESTERDAY, juice.id, 90); // 120%
  await log(YESTERDAY, mystery.id, 50);
  await log(TODAY, juice.id, 1000); // today is never completed
  await log(TODAY, mystery.id, 70);
  await log('2026-10-22', juice.id, 1000); // future

  const month = await getMonth('2026-10');
  assert.equal(month.month, '2026-10');
  assert.equal(month.completedDays, 2);
  assert.deepEqual(month.profile, { sex: 'male', age: 46 });
  assert.deepEqual(month.coverage, { missingFoods: 1, missingGrams: 50 });

  const vitaminC = rowOf(month, 'vitaminC');
  assert.deepEqual(
    [vitaminC.food, vitaminC.supplements, vitaminC.total, vitaminC.recommended, vitaminC.percent, vitaminC.status],
    [60, 0, 60, 75, 80, 'fair'],
  );
  assert.deepEqual([vitaminC.daysBelow, vitaminC.daysOverLimit], [1, 0]);
  assert.deepEqual(vitaminC.sources, [{ kind: 'food', id: juice.id, name: 'Juice', amount: 60, share: 1 }]);

  // Per day 0 of 30 g and 50 of 140 g lack vitamin C: averages of 25 g and 85 g.
  assert.deepEqual([vitaminC.unknownGrams, vitaminC.unknownShare], [25, 0.29]);
  assert.deepEqual([rowOf(month, 'vitaminK').unknownGrams, rowOf(month, 'vitaminK').unknownShare], [85, 1]);

  const mg = rowOf(month, 'magnesium');
  assert.deepEqual([mg.supplements, mg.limitAmount, mg.overLimit], [150, 150, false], 'the average stays under 250');
  assert.equal(mg.daysOverLimit, 1, 'but one day went over');
  assert.equal(mg.daysBelow, 1, '300 of 350 mg is 86%, 0 mg is below');
});

test('month with no completed days has zero amounts and null percent', async () => {
  await setProfile();
  const juice = await createFood('Juice', { vitaminC: 100 });
  const mystery = await createFood('Mystery');
  await log('2026-11-02', juice.id, 100);
  await log('2026-11-02', mystery.id, 100);

  for (const monthIso of ['2026-11', '2026-09']) {
    const month = await getMonth(monthIso);
    assert.equal(month.completedDays, 0);
    assert.deepEqual(month.coverage, { missingFoods: 0, missingGrams: 0 });
    assert.equal(month.nutrients.length, MICRO_KEYS.length);
    for (const row of month.nutrients) {
      assert.deepEqual(
        [row.food, row.supplements, row.total, row.percent, row.status, row.overLimit, row.estimatedShare, row.unknownGrams, row.unknownShare],
        [0, 0, 0, null, null, false, 0, 0, 0],
        `${monthIso} ${row.key}`,
      );
      assert.deepEqual([row.daysBelow, row.daysOverLimit, row.sources], [0, 0, []]);
    }
  }
});

test('range summarises only the given completed dates', async () => {
  await setProfile();
  const juice = await createFood('Juice', { vitaminC: 100 });
  await log('2026-09-30', juice.id, 40); // 53%, below
  await log('2026-10-05', juice.id, 1000); // between the given dates, but not one of them
  await log('2026-10-19', juice.id, 160);

  const settings = createSettingsRepo(server.db, { today: () => TODAY });
  const foodMicros = createFoodMicrosRepo(server.db, { reference: createReferenceRepo(server.db) });
  const supplements = createSupplementsRepo(server.db);
  const micros = createMicrosService(server.db, { settings, foodMicros, supplements, today: () => TODAY });

  const summary = micros.getRange(['2026-10-19', '2026-09-30', '2026-10-19', '2026-10-20']);
  assert.equal(summary.completedDays, 2);
  assert.equal(rowOf(summary, 'vitaminC').total, 100);
  assert.equal(rowOf(summary, 'vitaminC').daysBelow, 1);

  const empty = micros.getRange([]);
  assert.equal(empty.completedDays, 0);
  assert.deepEqual(empty.profile, { sex: 'male', age: 46 });
});

test('rejects invalid dates and months', async () => {
  assert.equal((await client.get('/api/micros/days/2026-02-30')).status, 400);
  assert.equal((await client.get('/api/micros/months/2026-13')).status, 400);
});
