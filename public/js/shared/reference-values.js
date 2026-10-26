/**
 * Dutch reference intakes for adults (18+, not pregnant or lactating) and the
 * upper limits that apply to them. Shared by the server and the browser.
 *
 * Sources: Gezondheidsraad (GR) 2018 vitamins and minerals; GR 2023 upper
 * limits, which follow the EFSA overview (v11, August 2025); GR 2026 fats
 * advisory; Voedingscentrum tables 05/2025; Richtlijnen goede voeding 2015.
 */
import { MICRO_KEYS } from './micronutrients.js';

export const Sex = Object.freeze({ FEMALE: 'female', MALE: 'male' });

export const MIN_AGE = 18;

/** What an upper limit means: a formal UL, an EFSA safe level, or a dietary guideline maximum. */
export const LimitKind = Object.freeze({ UL: 'ul', SAFE: 'safe', GUIDELINE: 'guideline' });

/** What a recommended amount is relative to. */
export const RecommendedPer = Object.freeze({ DAY: 'day', MJ: 'mj', ENERGY_PERCENT: 'energyPercent' });

export const KJ_PER_KCAL = 4.184;

const KCAL_PER_G_FAT = 9;

/**
 * @typedef {object} ReferenceRow
 * @property {string | null} sex Sex, or null for both sexes
 * @property {number} minAge inclusive
 * @property {number | null} maxAge inclusive, null for no upper age
 * @property {number | null} recommended in the nutrient's unit, per `per`
 * @property {string} per RecommendedPer
 * @property {'ADH' | 'AI' | null} kind ADH = adequate daily intake, AI = adequate intake
 * @property {boolean} indicative true when the value is only a rough guide
 * @property {number | null} upperLimit in the nutrient's unit per day
 * @property {string | null} limitKind LimitKind, null when there is no upper limit
 * @property {string} source
 */

/**
 * @param {Partial<ReferenceRow> & Pick<ReferenceRow, 'source'>} row
 * @returns {Readonly<ReferenceRow>}
 */
function row(fields) {
  return Object.freeze({
    sex: null,
    minAge: MIN_AGE,
    maxAge: null,
    recommended: null,
    per: RecommendedPer.DAY,
    kind: null,
    indicative: false,
    upperLimit: null,
    limitKind: null,
    ...fields,
  });
}

const F = Sex.FEMALE;
const M = Sex.MALE;
const { UL, SAFE, GUIDELINE } = LimitKind;
const { MJ, ENERGY_PERCENT } = RecommendedPer;

/** @type {Record<string, ReadonlyArray<ReferenceRow>>} */
const TABLE = {
  vitaminA: [
    row({ sex: M, recommended: 800, kind: 'ADH', upperLimit: 3000, limitKind: UL, source: 'GR 2018; UL EFSA 2024 (retinol only)' }),
    row({ sex: F, recommended: 680, kind: 'ADH', upperLimit: 3000, limitKind: UL, source: 'GR 2018; UL EFSA 2024 (retinol only)' }),
  ],
  thiamin: [row({ recommended: 0.1, per: MJ, kind: 'ADH', source: 'GR 2018 (EFSA)' })],
  riboflavin: [row({ recommended: 1.6, kind: 'ADH', source: 'GR 2018 (EFSA)' })],
  niacin: [
    row({
      recommended: 1.6,
      per: MJ,
      kind: 'ADH',
      upperLimit: 900,
      limitKind: UL,
      source: 'GR 2018; UL SCF 2002 nicotinamide (supplements)',
    }),
  ],
  vitaminB6: [
    row({ sex: M, maxAge: 50, recommended: 1.5, kind: 'ADH', upperLimit: 12, limitKind: UL, source: 'GR 2018; UL EFSA 2023' }),
    row({ sex: M, minAge: 51, recommended: 1.8, kind: 'ADH', upperLimit: 12, limitKind: UL, source: 'GR 2018; UL EFSA 2023' }),
    row({ sex: F, recommended: 1.5, kind: 'ADH', upperLimit: 12, limitKind: UL, source: 'GR 2018; UL EFSA 2023' }),
  ],
  folate: [
    row({ recommended: 300, kind: 'ADH', upperLimit: 1000, limitKind: UL, source: 'GR 2018; UL EFSA 2023 (folic acid only)' }),
  ],
  vitaminB12: [row({ recommended: 2.8, kind: 'ADH', source: 'GR 2018' })],
  vitaminC: [row({ recommended: 75, kind: 'ADH', source: 'GR 2018' })],
  vitaminD: [
    row({ maxAge: 69, recommended: 10, kind: 'AI', upperLimit: 100, limitKind: UL, source: 'GR 2018; UL EFSA 2023' }),
    row({ minAge: 70, recommended: 20, kind: 'ADH', upperLimit: 100, limitKind: UL, source: 'GR 2018; UL EFSA 2023' }),
  ],
  vitaminE: [
    row({ sex: M, recommended: 13, kind: 'AI', indicative: true, upperLimit: 300, limitKind: UL, source: 'GR 2018 (EFSA); UL EFSA 2024' }),
    row({ sex: F, recommended: 11, kind: 'AI', indicative: true, upperLimit: 300, limitKind: UL, source: 'GR 2018 (EFSA); UL EFSA 2024' }),
  ],
  vitaminK: [row({ recommended: 70, kind: 'AI', source: 'GR 2018 (EFSA)' })],
  calcium: [
    row({ maxAge: 24, recommended: 1000, kind: 'ADH', upperLimit: 2500, limitKind: UL, source: 'GR 2018 (EFSA); UL EFSA 2012' }),
    row({ sex: M, minAge: 25, maxAge: 69, recommended: 950, kind: 'ADH', upperLimit: 2500, limitKind: UL, source: 'GR 2018 (EFSA); UL EFSA 2012' }),
    row({ sex: F, minAge: 25, maxAge: 49, recommended: 950, kind: 'ADH', upperLimit: 2500, limitKind: UL, source: 'GR 2018 (EFSA); UL EFSA 2012' }),
    row({ sex: F, minAge: 50, maxAge: 69, recommended: 1100, kind: 'AI', upperLimit: 2500, limitKind: UL, source: 'GR 2018 (GR 2000); UL EFSA 2012' }),
    row({ minAge: 70, recommended: 1200, kind: 'AI', upperLimit: 2500, limitKind: UL, source: 'GR 2018 (GR 2000); UL EFSA 2012' }),
  ],
  magnesium: [
    row({ sex: M, recommended: 350, kind: 'AI', upperLimit: 250, limitKind: UL, source: 'GR 2018 (EFSA); UL SCF 2001 (supplements only)' }),
    row({ sex: F, recommended: 300, kind: 'AI', upperLimit: 250, limitKind: UL, source: 'GR 2018 (EFSA); UL SCF 2001 (supplements only)' }),
  ],
  iron: [
    row({ sex: M, recommended: 11, kind: 'ADH', upperLimit: 40, limitKind: SAFE, source: 'GR 2018 (EFSA); EFSA 2024 safe level' }),
    row({ sex: F, maxAge: 49, recommended: 16, kind: 'ADH', upperLimit: 40, limitKind: SAFE, source: 'GR 2018 premenopausal, Voedingscentrum age mapping' }),
    row({ sex: F, minAge: 50, recommended: 11, kind: 'ADH', upperLimit: 40, limitKind: SAFE, source: 'GR 2018 postmenopausal, Voedingscentrum age mapping' }),
  ],
  zinc: [
    row({ sex: M, recommended: 9, kind: 'ADH', upperLimit: 25, limitKind: UL, source: 'GR 2018 (NCM 2014); UL SCF 2002' }),
    row({ sex: F, recommended: 7, kind: 'ADH', upperLimit: 25, limitKind: UL, source: 'GR 2018 (NCM 2014); UL SCF 2002' }),
  ],
  selenium: [
    row({ recommended: 70, kind: 'AI', indicative: true, upperLimit: 255, limitKind: UL, source: 'GR 2018 (EFSA); UL EFSA 2023' }),
  ],
  iodine: [row({ recommended: 150, kind: 'AI', upperLimit: 600, limitKind: UL, source: 'GR 2018 (EFSA); UL SCF 2002' })],
  potassium: [row({ recommended: 3500, kind: 'AI', source: 'GR 2018 (EFSA)' })],
  phosphorus: [row({ recommended: 550, kind: 'AI', indicative: true, source: 'GR 2018 (EFSA)' })],
  copper: [row({ recommended: 0.9, kind: 'ADH', upperLimit: 5, limitKind: UL, source: 'GR 2018 (NCM 2014); UL SCF 2003' })],
  salt: [row({ upperLimit: 6, limitKind: GUIDELINE, source: 'Richtlijnen goede voeding 2015, kept in 2025' })],
  epaDha: [row({ recommended: 200, kind: 'AI', source: 'GR 2026 fats advisory' })],
  ala: [
    row({ recommended: 0.5, per: ENERGY_PERCENT, kind: 'AI', source: 'GR 2026 fats advisory (replaces 1% from 2001)' }),
  ],
};

/** Reference rows per nutrient key. Age bands are per nutrient and inclusive. */
export const REFERENCE_VALUES = Object.freeze(
  Object.fromEntries(MICRO_KEYS.map((key) => [key, Object.freeze(TABLE[key])])),
);

/**
 * @param {number} birthYear
 * @param {string} isoDate YYYY-MM-DD
 * @returns {number} the year difference, so birthdays within the year are ignored
 */
export function ageOn(birthYear, isoDate) {
  return Number(isoDate.slice(0, 4)) - birthYear;
}

/**
 * @param {string} key nutrient key
 * @param {{ sex: string, age: number }} person
 * @returns {ReferenceRow}
 * @throws {Error} when no row matches, which means the table has a gap
 */
export function referenceFor(key, { sex, age }) {
  const match = REFERENCE_VALUES[key]?.find(
    (ref) => (ref.sex === null || ref.sex === sex) && age >= ref.minAge && (ref.maxAge === null || age <= ref.maxAge),
  );
  if (!match) throw new Error(`No reference value for ${key} (${sex}, age ${age})`);
  return match;
}

/**
 * Turns a per-energy recommendation into an amount per day.
 * @param {ReferenceRow} ref
 * @param {number} kcalTarget daily energy target
 * @returns {number | null}
 */
function perDay(ref, kcalTarget) {
  if (ref.recommended === null) return null;
  if (ref.per === RecommendedPer.MJ) return (ref.recommended * kcalTarget * KJ_PER_KCAL) / 1000;
  if (ref.per === RecommendedPer.ENERGY_PERCENT) return (kcalTarget * ref.recommended) / 100 / KCAL_PER_G_FAT;
  return ref.recommended;
}

/**
 * @param {{ sex: string | null, birthYear: number | null, microTargets?: Record<string, number> }} profile
 * @param {string} isoDate day being viewed, which decides the age band
 * @param {number} kcalTarget daily energy target, used for per-energy values
 * @returns {Record<string, { recommended: number | null, upperLimit: number | null, limitKind: string | null, indicative: boolean }> | null}
 *   per-nutrient targets, or null when the profile lacks sex or birth year
 */
export function targetsFor(profile, isoDate, kcalTarget) {
  if (!profile.sex || !profile.birthYear) return null;
  // Clamped so an adult viewing an older day (when they were under 18) still gets adult values.
  const age = Math.max(MIN_AGE, ageOn(profile.birthYear, isoDate));
  const overrides = profile.microTargets ?? {};
  return Object.fromEntries(
    MICRO_KEYS.map((key) => {
      const ref = referenceFor(key, { sex: profile.sex, age });
      const overridden = typeof overrides[key] === 'number';
      return [
        key,
        {
          recommended: overridden ? overrides[key] : perDay(ref, kcalTarget),
          upperLimit: ref.upperLimit,
          limitKind: ref.limitKind,
          indicative: overridden ? false : ref.indicative,
        },
      ];
    }),
  );
}
