import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MICRONUTRIENTS,
  MICRO_BY_KEY,
  MICRO_KEYS,
  UlBasis,
  VitaminDUnit,
  roundMicro,
  statusFor,
  vitaminDFromUg,
  vitaminDToUg,
} from '../public/js/shared/micronutrients.js';
import { REFERENCE_VALUES, referenceFor, targetsFor } from '../public/js/shared/reference-values.js';

test('MICRO_KEYS lists the 23 nutrients in display order', () => {
  assert.equal(MICRO_KEYS.length, 23);
  assert.deepEqual(MICRO_KEYS.slice(0, 2), ['vitaminA', 'thiamin']);
  assert.deepEqual(MICRO_KEYS.slice(-3), ['salt', 'epaDha', 'ala']);
});

test('fromNevo derives salt, EPA+DHA and folate DFE and keeps blanks unknown', () => {
  const v = (cols) => (name) => cols[name] ?? null;
  assert.equal(MICRO_BY_KEY.salt.fromNevo(v({ 'NA (mg)': 400 })), 1);
  assert.equal(MICRO_BY_KEY.epaDha.fromNevo(v({ 'F20:5CN3 (g)': 0.5, 'F22:6CN3 (g)': 1.2 })), 1700);
  assert.equal(MICRO_BY_KEY.epaDha.fromNevo(v({ 'F22:6CN3 (g)': 1.2 })), 1200);
  assert.equal(MICRO_BY_KEY.epaDha.fromNevo(v({})), null);
  assert.equal(MICRO_BY_KEY.folate.fromNevo(v({ 'FOLFD (µg)': 100, 'FOLAC (µg)': 10 })), 117);
  assert.equal(MICRO_BY_KEY.folate.fromNevo(v({ 'FOL (µg)': 80 })), 80);
  assert.equal(MICRO_BY_KEY.iodine.fromNevo(v({})), null);
});

test('statusFor uses 66 and 100 percent', () => {
  assert.equal(statusFor(65.9), 'low');
  assert.equal(statusFor(66), 'fair');
  assert.equal(statusFor(99.9), 'fair');
  assert.equal(statusFor(100), 'good');
  assert.equal(statusFor(null), null);
});

test('roundMicro keeps three significant digits', () => {
  assert.equal(roundMicro(1234.5), 1230);
  assert.equal(roundMicro(0.012345), 0.0123);
  assert.equal(roundMicro(0), 0);
});

for (const [amount, unit, ug] of [
  [400, VitaminDUnit.IU, 10],
  [1000, VitaminDUnit.IU, 25],
  [25, VitaminDUnit.MICROGRAM, 25],
]) {
  test(`vitaminDToUg turns ${amount} ${unit} into ${ug} µg`, () => {
    assert.equal(vitaminDToUg(amount, unit), ug);
  });
}

test('vitaminDFromUg converts µg into the chosen unit', () => {
  assert.equal(vitaminDFromUg(25, VitaminDUnit.IU), 1000);
  assert.equal(vitaminDFromUg(25, VitaminDUnit.MICROGRAM), 25);
});

test('flipping vitamin D units round-trips without float noise', () => {
  for (const ug of [25, 0.1, 12.3456, 7.5]) {
    assert.equal(vitaminDToUg(vitaminDFromUg(ug, VitaminDUnit.IU), VitaminDUnit.IU), ug);
  }
  assert.equal(vitaminDToUg(0.3 * 3, VitaminDUnit.IU), 0.0225, 'rounding hides 0.30000000000000004-style noise');
});

test('every nutrient has a positive per-100 g ceiling', () => {
  for (const micro of MICRONUTRIENTS) assert.ok(micro.max > 0, micro.key);
});

test('nutrients without an upper-limit basis have no upper limit in any reference row', () => {
  for (const micro of MICRONUTRIENTS) {
    const limits = REFERENCE_VALUES[micro.key].map((ref) => ref.upperLimit !== null);
    assert.ok(limits.every((hasLimit) => hasLimit === (micro.ulBasis !== UlBasis.NONE)), micro.key);
  }
});

test('targetsFor picks the band by sex and age and applies overrides', () => {
  const woman = targetsFor({ sex: 'female', birthYear: 1990, microTargets: {} }, '2026-10-26', 2000);
  const man = targetsFor({ sex: 'male', birthYear: 1990, microTargets: { vitaminD: 25 } }, '2026-10-26', 2000);
  assert.equal(woman.iron.recommended, 16);
  assert.equal(man.iron.recommended, 11);
  assert.equal(man.iron.limitKind, 'safe');
  assert.equal(man.vitaminD.recommended, 25);
  assert.equal(man.vitaminD.upperLimit, 100);
  assert.equal(woman.vitaminA.recommended, 680);
  assert.equal(woman.salt.recommended, null);
  assert.equal(woman.salt.upperLimit, 6);
  assert.equal(woman.salt.limitKind, 'guideline');
  assert.equal(woman.vitaminE.indicative, true);
  assert.equal(targetsFor({ sex: null, birthYear: 1990, microTargets: {} }, '2026-10-26', 2000), null);
});

test('a target override clears the indicative flag', () => {
  const profile = { sex: 'male', birthYear: 1990, microTargets: { vitaminE: 15 } };
  const t = targetsFor(profile, '2026-10-26', 2000);
  assert.equal(t.vitaminE.recommended, 15);
  assert.equal(t.vitaminE.indicative, false);
});

test('targetsFor uses age bands on the viewed date', () => {
  const at = (birthYear, sex) => targetsFor({ sex, birthYear, microTargets: {} }, '2026-10-26', 2000);
  assert.equal(at(1957, 'male').vitaminD.recommended, 10); // 69
  assert.equal(at(1956, 'male').vitaminD.recommended, 20); // 70
  assert.equal(at(1976, 'male').vitaminB6.recommended, 1.5); // 50
  assert.equal(at(1975, 'male').vitaminB6.recommended, 1.8); // 51
  assert.equal(at(1977, 'female').calcium.recommended, 950); // 49
  assert.equal(at(1976, 'female').calcium.recommended, 1100); // 50
  assert.equal(at(1976, 'female').iron.recommended, 11); // 50
});

test('targetsFor converts energy-based values with the kcal target', () => {
  const t = targetsFor({ sex: 'male', birthYear: 1990, microTargets: {} }, '2026-10-26', 2000);
  assert.equal(roundMicro(t.thiamin.recommended), 0.837); // 0.1 mg/MJ × 8.368 MJ
  assert.equal(roundMicro(t.niacin.recommended), 13.4); // 1.6 mg/MJ
  assert.equal(roundMicro(t.ala.recommended), 1.11); // 0.5 % energy / 9 kcal per g
});

test('every nutrient has a reference row for each sex from 18 up', () => {
  for (const key of MICRO_KEYS) {
    for (const sex of ['female', 'male']) {
      for (const age of [18, 50, 51, 70, 71, 90]) {
        assert.doesNotThrow(() => referenceFor(key, { sex, age }), `${key} ${sex} ${age}`);
      }
    }
  }
});

test('targetsFor clamps ages under 18 to the adult values', () => {
  const at = (birthYear, isoDate) => targetsFor({ sex: 'female', birthYear, microTargets: {} }, isoDate, 2000);
  assert.deepEqual(at(2008, '2025-06-01'), at(2008, '2026-06-01')); // 17 vs 18
});

test('referenceFor throws for an age below the first band', () => {
  assert.throws(() => referenceFor('iron', { sex: 'male', age: 17 }), /No reference value/);
});
