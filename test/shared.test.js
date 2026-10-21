import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scaleNutrients,
  sumNutrients,
  roundNutrients,
  emptyNutrients,
  parseAmount,
  parseNumber,
} from '../public/js/shared/nutrition.js';
import { addDays, isIsoDate, formatDayTitle, toIsoDate } from '../public/js/shared/dates.js';
import { MEAL_SLOTS, MealSlot, SLOT_LABELS, DEFAULT_SETTINGS } from '../public/js/shared/constants.js';
import { slotForTime, slotsAhead } from '../public/js/shared/meal-time.js';

test('scaleNutrients scales per-100g values by grams', () => {
  assert.deepEqual(scaleNutrients({ kcal: 380, protein: 13, carbs: 60, fat: 7, fiber: 10 }, 60), {
    kcal: 228,
    protein: 7.8,
    carbs: 36,
    fat: 4.2,
    fiber: 6,
  });
});

test('roundNutrients rounds kcal to int and macros to 1 decimal', () => {
  assert.deepEqual(roundNutrients({ kcal: 227.6, protein: 7.84, carbs: 36.04, fat: 4.25, fiber: 6 }), {
    kcal: 228,
    protein: 7.8,
    carbs: 36,
    fat: 4.3,
    fiber: 6,
  });
});

test('sumNutrients of empty list is all zeros', () => {
  assert.deepEqual(sumNutrients([]), emptyNutrients());
});

test('sumNutrients adds each nutrient', () => {
  const a = { kcal: 100, protein: 10, carbs: 5, fat: 2, fiber: 1 };
  assert.deepEqual(sumNutrients([a, a]), { kcal: 200, protein: 20, carbs: 10, fat: 4, fiber: 2 });
});

test('parseAmount', () => {
  const cases = [
    ['12,5', 12.5],
    ['12.5', 12.5],
    [' 150 ', 150],
    [150, 150],
    ['', null],
    ['abc', null],
    ['0', null],
    ['-5', null],
    ['1,2,3', null],
    [null, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseAmount(input), expected, `input ${JSON.stringify(input)}`);
  }
});

test('parseNumber allows zero but rejects negatives and junk', () => {
  const cases = [
    ['0', 0],
    ['0,2', 0.2],
    ['12.5', 12.5],
    [0, 0],
    ['', null],
    ['-1', null],
    ['1e3', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseNumber(input), expected, `input ${JSON.stringify(input)}`);
  }
});

test('addDays crosses month and DST boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-10-25', -1), '2026-10-24');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
});

test('isIsoDate rejects impossible dates', () => {
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-10-21'), true);
  assert.equal(isIsoDate('21-10-2026'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate(undefined), false);
});

test('toIsoDate uses the local calendar date', () => {
  assert.equal(toIsoDate(new Date(2026, 9, 21, 0, 30)), '2026-10-21');
});

test('formatDayTitle', () => {
  assert.deepEqual(formatDayTitle('2026-10-21', '2026-10-21'), { title: 'Today', subtitle: 'Wednesday 21 Oct' });
  assert.equal(formatDayTitle('2026-10-22', '2026-10-21').title, 'Tomorrow');
  assert.equal(formatDayTitle('2026-10-20', '2026-10-21').title, 'Yesterday');
  assert.equal(formatDayTitle('2026-10-25', '2026-10-21').title, 'Sunday');
});

test('meal slots are fixed and ordered', () => {
  assert.deepEqual(MEAL_SLOTS, ['breakfast', 'lunch', 'dinner', 'snacks']);
  assert.equal(MealSlot.SNACKS, 'snacks');
  assert.equal(SLOT_LABELS.breakfast, 'Breakfast');
  assert.ok(Object.isFrozen(MealSlot));
  assert.deepEqual(DEFAULT_SETTINGS, { kcalTarget: 2000, proteinTarget: 120, offCountry: 'nl' });
});

test('slotForTime keeps the existing meal boundaries', () => {
  const at = (hh, mm) => new Date(2026, 9, 21, hh, mm);
  assert.equal(slotForTime(at(10, 29)), 'breakfast');
  assert.equal(slotForTime(at(10, 30)), 'lunch');
  assert.equal(slotForTime(at(15, 0)), 'dinner');
  assert.equal(slotForTime(at(21, 0)), 'snacks');
});

test('slotsAhead includes the current slot and always snacks', () => {
  const at = (hh, mm) => new Date(2026, 9, 21, hh, mm);
  assert.deepEqual(slotsAhead(at(7, 0)), ['breakfast', 'lunch', 'dinner', 'snacks']);
  assert.deepEqual(slotsAhead(at(14, 0)), ['lunch', 'dinner', 'snacks']);
  assert.deepEqual(slotsAhead(at(22, 30)), ['snacks']);
});
