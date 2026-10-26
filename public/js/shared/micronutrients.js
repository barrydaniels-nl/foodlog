/**
 * Micronutrient definitions shared by the server and the browser: the 23
 * tracked nutrients in display order, how each is read from a NEVO row, and
 * the thresholds used to colour progress.
 *
 * Amounts are always per 100 g in storage. Keep this file free of Node-only
 * APIs because it also runs in the browser.
 */

export const MicroGroup = Object.freeze({ VITAMINS: 'vitamins', MINERALS: 'minerals', FATTY_ACIDS: 'fattyAcids' });

/**
 * Which intake an upper limit applies to:
 * - `total`: food and supplements together;
 * - `supplement`: supplements only;
 * - `retinol`: preformed vitamin A (retinol) only;
 * - `none`: no upper limit exists.
 */
export const UlBasis = Object.freeze({ TOTAL: 'total', SUPPLEMENT: 'supplement', RETINOL: 'retinol', NONE: 'none' });

/** Where a micronutrient value came from. */
export const Origin = Object.freeze({ LABEL: 'label', NEVO: 'nevo', AI: 'ai' });

export const MicroStatus = Object.freeze({ LOW: 'low', FAIR: 'fair', GOOD: 'good' });

/** Below this percentage of the recommended amount a nutrient is flagged `low`. */
export const LOW_PERCENT = 66;

/** "≈" is shown when more than this share of a total comes from estimated (AI) values. */
export const ESTIMATED_SHARE_LIMIT = 0.25;

/**
 * From this share of the day's food grams without a value for a nutrient, its
 * total is too much of a lower bound to colour as low, fair or good.
 */
export const UNKNOWN_SHARE_LIMIT = 0.5;

export const IU_PER_UG_VITAMIN_D = 40;

/** The units vitamin D can be entered in; storage is always µg. */
export const VitaminDUnit = Object.freeze({ MICROGRAM: 'ug', IU: 'iu' });

/** Six significant digits hide floating-point noise, so a µg/IU round trip gives back the typed number. */
const roundConversion = (value) => Number(value.toPrecision(6));

/**
 * @param {number} amount as entered
 * @param {string} unit a VitaminDUnit
 * @returns {number} µg
 */
export function vitaminDToUg(amount, unit) {
  return unit === VitaminDUnit.IU ? roundConversion(amount / IU_PER_UG_VITAMIN_D) : amount;
}

/**
 * @param {number} ug
 * @param {string} unit a VitaminDUnit
 * @returns {number} the amount in `unit`
 */
export function vitaminDFromUg(ug, unit) {
  return unit === VitaminDUnit.IU ? roundConversion(ug * IU_PER_UG_VITAMIN_D) : ug;
}

/** Internal key, never displayed: preformed vitamin A, used only for its upper limit. */
export const RETINOL_KEY = 'retinol';
export const NEVO_RETINOL_COLUMN = 'RETOL (µg)';

/** @typedef {(column: string) => number | null} NevoReader reads one NEVO column, null when blank */

/**
 * @param {string} name NEVO CSV header
 * @returns {(value: NevoReader) => number | null} reader for that single column as-is
 */
const column = (name) => (value) => value(name);

/**
 * Sums the known values, or returns null when none is known, so a blank
 * stays "unknown" instead of becoming 0.
 * @param {Array<number | null>} values
 * @returns {number | null}
 */
function sumKnown(values) {
  const known = values.filter((v) => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/** Folic acid counts 1.7 times as much as natural folate in dietary folate equivalents. */
const FOLIC_ACID_DFE_FACTOR = 1.7;

/**
 * Folate in dietary folate equivalents, falling back to total folate when the
 * natural/folic-acid split is blank.
 * @param {NevoReader} value
 * @returns {number | null}
 */
function folateFromNevo(value) {
  const natural = value('FOLFD (µg)');
  const folicAcid = value('FOLAC (µg)');
  if (natural === null && folicAcid === null) return value('FOL (µg)');
  return (natural ?? 0) + FOLIC_ACID_DFE_FACTOR * (folicAcid ?? 0);
}

/**
 * Table salt is 2.5 times its sodium weight.
 * @param {NevoReader} value
 * @returns {number | null} grams
 */
function saltFromNevo(value) {
  const sodiumMg = value('NA (mg)');
  return sodiumMg === null ? null : (sodiumMg * 2.5) / 1000;
}

/**
 * @param {NevoReader} value
 * @returns {number | null} mg, summing whichever of EPA and DHA is known
 */
function epaDhaFromNevo(value) {
  const grams = sumKnown([value('F20:5CN3 (g)'), value('F22:6CN3 (g)')]);
  return grams === null ? null : grams * 1000;
}

/**
 * @param {string} key
 * @param {string} label
 * @param {'mg' | 'µg' | 'g'} unit
 * @param {string} group MicroGroup
 * @param {string} ulBasis UlBasis
 * @param {number} max per-100 g sanity ceiling, see MICRONUTRIENTS
 * @param {(value: NevoReader) => number | null} fromNevo
 * @param {number} [supplementFactor] multiplier from entered supplement amount to counted amount
 */
function define(key, label, unit, group, ulBasis, max, fromNevo, supplementFactor = 1) {
  return Object.freeze({ key, label, unit, group, ulBasis, supplementFactor, max, fromNevo });
}

const { VITAMINS, MINERALS, FATTY_ACIDS } = MicroGroup;
const { TOTAL, SUPPLEMENT, RETINOL, NONE } = UlBasis;

/**
 * The tracked micronutrients in display order. Each `max` is a per-100 g
 * sanity ceiling (about 3x the richest plausible food, including fortified
 * yeast, liver, oils and potassium-chloride salt substitutes) used to reject implausible label and AI values.
 */
export const MICRONUTRIENTS = Object.freeze([
  define('vitaminA', 'Vitamin A', 'µg', VITAMINS, RETINOL, 60000, column('VITA_RAE (µg)')),
  define('thiamin', 'Thiamin (B1)', 'mg', VITAMINS, NONE, 150, column('THIA (mg)')),
  define('riboflavin', 'Riboflavin (B2)', 'mg', VITAMINS, NONE, 150, column('RIBF (mg)')),
  define('niacin', 'Niacin (B3)', 'mg', VITAMINS, SUPPLEMENT, 600, column('NIAEQ (mg)')),
  define('vitaminB6', 'Vitamin B6', 'mg', VITAMINS, TOTAL, 100, column('VITB6 (mg)')),
  define('folate', 'Folate (B11)', 'µg', VITAMINS, SUPPLEMENT, 6000, folateFromNevo, FOLIC_ACID_DFE_FACTOR),
  define('vitaminB12', 'Vitamin B12', 'µg', VITAMINS, NONE, 1000, column('VITB12 (µg)')),
  define('vitaminC', 'Vitamin C', 'mg', VITAMINS, NONE, 5000, column('VITC (mg)')),
  define('vitaminD', 'Vitamin D', 'µg', VITAMINS, TOTAL, 750, column('VITD (µg)')),
  define('vitaminE', 'Vitamin E', 'mg', VITAMINS, TOTAL, 450, column('VITE (mg)')),
  define('vitaminK', 'Vitamin K', 'µg', VITAMINS, NONE, 5000, column('VITK (µg)')),
  define('calcium', 'Calcium', 'mg', MINERALS, TOTAL, 4000, column('CA (mg)')),
  define('magnesium', 'Magnesium', 'mg', MINERALS, SUPPLEMENT, 1800, column('MG (mg)')),
  define('iron', 'Iron', 'mg', MINERALS, TOTAL, 400, column('FE (mg)')),
  define('zinc', 'Zinc', 'mg', MINERALS, TOTAL, 300, column('ZN (mg)')),
  define('selenium', 'Selenium', 'µg', MINERALS, TOTAL, 6000, column('SE (µg)')),
  define('iodine', 'Iodine', 'µg', MINERALS, TOTAL, 500000, column('ID (µg)')),
  define('potassium', 'Potassium', 'mg', MINERALS, NONE, 60000, column('K (mg)')),
  define('phosphorus', 'Phosphorus', 'mg', MINERALS, NONE, 10000, column('P (mg)')),
  define('copper', 'Copper', 'mg', MINERALS, TOTAL, 40, column('CU (mg)')),
  define('salt', 'Salt', 'g', MINERALS, TOTAL, 100, saltFromNevo),
  define('epaDha', 'EPA + DHA', 'mg', FATTY_ACIDS, NONE, 100000, epaDhaFromNevo),
  define('ala', 'ALA', 'g', FATTY_ACIDS, NONE, 100, column('F18:3CN3 (g)')),
]);

export const MICRO_KEYS = Object.freeze(MICRONUTRIENTS.map((micro) => micro.key));

export const MICRO_BY_KEY = Object.freeze(Object.fromEntries(MICRONUTRIENTS.map((micro) => [micro.key, micro])));

/**
 * @param {number | null} percent share of the recommended amount, 100 = target met
 * @returns {string | null} a MicroStatus, or null when there is nothing to compare
 */
export function statusFor(percent) {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return null;
  if (percent < LOW_PERCENT) return MicroStatus.LOW;
  if (percent < 100) return MicroStatus.FAIR;
  return MicroStatus.GOOD;
}

/**
 * Rounds to three significant digits, enough for display and storage without
 * floating-point noise.
 * @param {number} value
 * @returns {number}
 */
export function roundMicro(value) {
  return Number(value.toPrecision(3));
}
