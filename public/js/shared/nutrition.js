/**
 * Nutrition maths shared by the server and the browser so totals shown while
 * editing always match what the server stores.
 *
 * A `Nutrients` object has the keys in NUTRIENT_KEYS.
 */
import { NUTRIENT_KEYS } from './constants.js';

/** @returns {Record<string, number>} all nutrients set to zero */
export function emptyNutrients() {
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, 0]));
}

/**
 * @param {Record<string, number>} per100 nutrient values per 100 g
 * @param {number} grams amount eaten
 * @returns {Record<string, number>} unrounded nutrients for that amount
 */
export function scaleNutrients(per100, grams) {
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, ((per100[key] ?? 0) * grams) / 100]));
}

/**
 * @param {Array<Record<string, number>>} list
 * @returns {Record<string, number>} per-nutrient sum
 */
export function sumNutrients(list) {
  const total = emptyNutrients();
  for (const item of list) {
    for (const key of NUTRIENT_KEYS) total[key] += item[key] ?? 0;
  }
  return total;
}

/**
 * Rounds for display: kcal to whole numbers, macros to one decimal.
 * @param {Record<string, number>} nutrients
 * @returns {Record<string, number>}
 */
export function roundNutrients(nutrients) {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => {
      const value = nutrients[key] ?? 0;
      return [key, key === 'kcal' ? Math.round(value) : Math.round(value * 10) / 10];
    }),
  );
}

/**
 * Parses a user-typed non-negative number. Accepts a decimal comma because
 * Dutch iOS keyboards produce "12,5".
 * @param {string|number|null|undefined} input
 * @returns {number|null} a number ≥ 0, or null when invalid
 */
export function parseNumber(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  if (typeof input !== 'string') return null;
  const normalized = input.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(normalized)) return null;
  return Number(normalized);
}

/**
 * Parses a user-typed amount in grams.
 * @param {string|number|null|undefined} input
 * @returns {number|null} a positive number, or null when invalid
 */
export function parseAmount(input) {
  const value = parseNumber(input);
  return value !== null && value > 0 ? value : null;
}
