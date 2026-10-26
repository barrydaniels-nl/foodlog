/** User settings: daily targets and the Open Food Facts search region. */
import { DEFAULT_SETTINGS, OFF_COUNTRIES, OFF_WORLD } from '../public/js/shared/constants.js';
import { MICRO_BY_KEY, MICRO_KEYS } from '../public/js/shared/micronutrients.js';
import { MIN_AGE, Sex } from '../public/js/shared/reference-values.js';
import { HttpError } from './http.js';
import { requireNumber } from './validate.js';

const MIN_BIRTH_YEAR = 1900;
// Generous cap relative to the default target: it catches unit slips (mg vs µg) without blocking real megadoses.
const MICRO_TARGET_MAX_FACTOR = 100;

function validateSex(sex) {
  if (sex === null) return null;
  if (!Object.values(Sex).includes(sex)) {
    throw new HttpError(400, `sex must be one of: ${Object.values(Sex).join(', ')}`);
  }
  return sex;
}

function validateBirthYear(birthYear, currentYear) {
  if (birthYear === null) return null;
  const maxYear = currentYear - MIN_AGE;
  const year = requireNumber(birthYear, 'birthYear', { min: MIN_BIRTH_YEAR, max: maxYear });
  if (!Number.isInteger(year)) throw new HttpError(400, 'birthYear must be a whole number');
  return year;
}

function validateMicroTargets(microTargets) {
  if (typeof microTargets !== 'object' || microTargets === null || Array.isArray(microTargets)) {
    throw new HttpError(400, 'microTargets must be an object');
  }
  const clean = {};
  for (const [key, value] of Object.entries(microTargets)) {
    if (!MICRO_KEYS.includes(key)) throw new HttpError(400, `microTargets has an unknown nutrient: ${key}`);
    const target = requireNumber(value, `microTargets.${key}`, { max: MICRO_BY_KEY[key].max * MICRO_TARGET_MAX_FACTOR });
    // Zero would divide by zero when turned into percentages.
    if (target <= 0) throw new HttpError(400, `microTargets.${key} must be above 0`);
    clean[key] = target;
  }
  return clean;
}

function validatePatch(patch, currentYear) {
  const clean = {};
  if (patch.kcalTarget !== undefined) {
    clean.kcalTarget = Math.round(requireNumber(patch.kcalTarget, 'kcalTarget', { min: 500, max: 10000 }));
  }
  if (patch.proteinTarget !== undefined) {
    clean.proteinTarget = Math.round(requireNumber(patch.proteinTarget, 'proteinTarget', { min: 0, max: 500 }));
  }
  if (patch.offCountry !== undefined) {
    if (patch.offCountry !== OFF_WORLD && !Object.hasOwn(OFF_COUNTRIES, patch.offCountry)) {
      throw new HttpError(400, `offCountry must be one of: ${[...Object.keys(OFF_COUNTRIES), OFF_WORLD].join(', ')}`);
    }
    clean.offCountry = patch.offCountry;
  }
  // A missing or null sex/birthYear clears the stored profile value.
  if ('sex' in patch) clean.sex = validateSex(patch.sex ?? null);
  if ('birthYear' in patch) clean.birthYear = validateBirthYear(patch.birthYear ?? null, currentYear);
  if (patch.microTargets !== undefined) clean.microTargets = validateMicroTargets(patch.microTargets);
  return clean;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{today: () => string}} deps `today` gives YYYY-MM-DD; its year bounds birthYear
 */
export function createSettingsRepo(db, { today }) {
  const selectAll = db.prepare('SELECT key, value FROM settings');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  /** @returns {{kcalTarget: number, proteinTarget: number, offCountry: string, sex: string|null, birthYear: number|null, microTargets: Record<string, number>}} */
  function get() {
    const stored = Object.fromEntries(selectAll.all().map((row) => [row.key, JSON.parse(row.value)]));
    const settings = { ...DEFAULT_SETTINGS, microTargets: { ...DEFAULT_SETTINGS.microTargets } };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in stored) settings[key] = stored[key];
    }
    return settings;
  }

  function update(patch) {
    const clean = validatePatch(patch ?? {}, Number(today().slice(0, 4)));
    for (const [key, value] of Object.entries(clean)) upsert.run(key, JSON.stringify(value));
    return get();
  }

  return { get, update };
}

/**
 * @param {ReturnType<import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createSettingsRepo>} settings
 */
export function registerSettingsRoutes(router, settings) {
  router.add('GET', '/api/settings', () => settings.get());
  router.add('PUT', '/api/settings', ({ body }) => settings.update(body));
}
